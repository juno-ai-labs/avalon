import { fallbackWorkspacePlacementAffinity } from "../lib/durable-object-namespace";
import { Hono } from "hono";
import {
  AutomationDraftSchema,
  asUserId,
  asWorkspaceId,
} from "@rally/contracts";
import { CanvasVisibilitySchema } from "@rally/contracts/canvases";
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
import { attachWorkstreamRuntimeResource } from "../services/workstream-object-client";
import { createAutomation } from "../services/automation-service";
import { createCanvas } from "../services/canvas-service";
import { enqueueWorkspaceConnectorEvent } from "../services/workspace-connector-event-ingress";
import { createTranscriptObjectPort } from "../runtime/transcript-port";
import { hostedParentStub } from "../services/conversation-parent-client";

const row = z.record(z.string(), z.union([z.string(), z.number(), z.null()]));

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
  /**
   * Stored bodies a seeded resource's `content_ref` names, written to
   * `PAYLOADS` before the rows, as a publish stores its bytes before its row
   * points at them. Keys are bounded to the Organization's `seed/` prefix.
   */
  payloads: z.array(z.strictObject({
    key: z.string().min(1),
    contentType: z.string().min(1),
    text: z.string(),
  })),
  workspaceTables: z.record(z.string(), z.array(row)),
  automations: z.array(seedAutomation),
  canvases: z.array(z.strictObject({
    id: z.string().uuid(),
    title: z.string().min(1),
    createdByUserId: z.string().uuid(),
    visibility: CanvasVisibilitySchema,
    participantUserIds: z.array(z.string().uuid()),
    /** Chat turns in the published transcript vocabulary, as a captured fixture holds them. */
    messages: z.array(row),
    /** Workspace resources this seed notes as the Canvas's artifacts, by Rally. */
    artifactResourceIds: z.array(z.string().uuid()),
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
  canvases: z.array(z.strictObject({
    canvasId: z.string().uuid(),
    copied: z.record(z.string(), z.number()),
  })),
});

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

/**
 * The seed's stored bodies, written where a resource's `content_ref` names
 * them and only under the Organization's `seed/` prefix, so the route cannot
 * overwrite a body a real write stored.
 */
export async function seedPayloads(
  env: Pick<Env, "AVALON_REGION" | "PAYLOADS">,
  workspaceId: string,
  payloads: z.infer<typeof SeedProductBodySchema>["payloads"],
): Promise<void> {
  const prefix = `${env.AVALON_REGION}/${workspaceId}/seed/`;
  for (const payload of payloads) {
    if (!payload.key.startsWith(prefix)) {
      throw new ApiError(422, "seed_payload_key_not_allowed", `A seed payload key must start with ${prefix}`);
    }
    await env.PAYLOADS.put(payload.key, payload.text, { httpMetadata: { contentType: payload.contentType } });
  }
}

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
  const workspaceDatabase = withWorkspaceRuntimeDatabase(env, workspaceId);

  await seedPayloads(env, workspaceId, body.payloads);

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
      // A row seeded before its body existed is repaired on a re-run: its
      // `content_ref` is filled where it is still empty, never replaced.
      const columns = Object.keys(record).filter((column) => record[column] !== null);
      const conflict = columns.includes("content_ref")
        ? `DO UPDATE SET content_ref = COALESCE(${table}.content_ref, excluded.content_ref)`
        : "DO NOTHING";
      await workspaceDatabase.DB.prepare(
        `INSERT INTO ${table} (${columns.join(", ")})
         VALUES (${columns.map(() => "?").join(", ")})
         ON CONFLICT(id) ${conflict}`,
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
  for (const canvas of body.canvases) {
    results.push({ canvasId: canvas.id, copied: await seedCanvas(env, workspaceId, canvas) });
  }
  return { seeded: true, workspaceTables: workspaceCounts, automations, canvases: results };
}

/**
 * One Canvas: made by `createCanvas` as its creator, shared, its Chat's turns
 * restored from the fixture through the transcript port, and its artifacts
 * attached to the Chat and noted on the Canvas as Rally's, the note a publish
 * makes. A re-run finds the Canvas (`created: false`), replays each turn by
 * its id, and notes each artifact again, which is idempotent.
 */
async function seedCanvas(env: Env, workspaceId: string, canvas: z.infer<typeof SeedProductBodySchema>["canvases"][number]) {
  const copied: Record<string, number> = {};
  await createCanvas(env, { workspaceId, creatorUserId: canvas.createdByUserId, title: canvas.title, canvasId: canvas.id });
  const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, workspaceId,
    workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspaceId)));
  const creator = { userId: asUserId(canvas.createdByUserId), actorRole: "owner" as const };
  if (canvas.visibility !== "creator") {
    await workspace.canvasSetAudience({ workspaceId, canvasId: canvas.id, actor: creator,
      update: { visibility: canvas.visibility, userIds: canvas.participantUserIds.map(asUserId) } });
  }
  copied.participants = canvas.participantUserIds.length;
  // Idempotent: the Canvas's runtime environment is already routed, and this
  // answers with it.
  const routed = await bootstrapWorkstreamRuntimeEnvironment(env, workspaceId, canvas.id, "canvas");
  const transcript = createTranscriptObjectPort(routed, workspaceId, canvas.id);
  for (const message of canvas.messages) {
    const authorType = String(message.author_type);
    const actor = authorType === "agent" ? "assistant" : authorType;
    if (actor !== "human" && actor !== "assistant" && actor !== "system") {
      throw new Error("seed_conversation_actor_invalid");
    }
    const messageType = String(message.message_type);
    if (messageType !== "text" && messageType !== "system") throw new Error("seed_conversation_type_invalid");
    await transcript.seedDevelopmentConversationTurn({
      turnId: String(message.id),
      clientMessageId: message.client_message_id === null || message.client_message_id === undefined
        ? null : String(message.client_message_id),
      actor,
      authorUserId: message.author_user_id === null || message.author_user_id === undefined
        ? null : String(message.author_user_id),
      authorSnapshot: actor === "human"
        ? { displayName: String(message.author_name_snapshot ?? ""), avatarUrl: null }
        : null,
      externalActorJson: null,
      messageType,
      text: String(message.text_content ?? ""),
      structuredContentJson: null,
      producedByRunId: null,
      expectedTranscriptSequence: Number(message.sequence_number),
      createdAtUtc: String(message.created_at),
    });
  }
  copied.chat_turns = canvas.messages.length;
  for (const resourceId of canvas.artifactResourceIds) {
    // The runtime attach port, as a publish attaches its resource: the route
    // has no session for the conversation to verify. Re-runs repair partial
    // seeds; an attachment that already exists is that repair finding
    // nothing to do.
    await attachWorkstreamRuntimeResource(env, {
      workspaceId, workstreamId: canvas.id, substreamId: "0", resourceId, attachedByUserId: null,
    }).catch((error: unknown) => {
      const code = error instanceof Error ? error.message : "";
      if (code !== "resource_already_attached" && code !== "conflict") throw error;
    });
    await workspace.canvasNoteArtifact({ workspaceId, canvasId: canvas.id, resourceId, editor: { kind: "rally", id: null } });
  }
  copied.artifacts = canvas.artifactResourceIds.length;
  return copied;
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
