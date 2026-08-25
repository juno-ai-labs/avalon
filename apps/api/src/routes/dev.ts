import { Hono } from "hono";
import { asUserId, asWorkspaceId } from "@avalon/contracts";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";

import type { Env } from "../env";
import { workspaceDOName } from "../durable-objects/names";
import { ApiError } from "../lib/api-error";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import {
  bootstrapWorkstreamRuntimeEnvironment,
} from "../services/workstream-runtime-database";
import { withWorkspaceRuntimeDatabase } from "../services/workspace-runtime-database";
import { readWorkstreamAuthorityControl } from "../services/workstream-authority";
import { WorkstreamObjectClient } from "../services/workstream-object-client";
import { createIdentityObjectPort } from "../runtime/identity-port";

const row = z.record(z.string(), z.union([z.string(), z.number(), z.null()]));

/**
 * Seed tool receipts into `tool_effects` directly.
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
  database: D1Database,
  receipts: z.infer<typeof row>[],
  copied: Record<string, number>,
): Promise<void> {
  for (const [position, receipt] of receipts.entries()) {
    const id = String(receipt.id);
    const plan = typeof receipt.execution_plan_json === "string" ? receipt.execution_plan_json : null;
    const at = (value: unknown): number | null =>
      typeof value === "string" ? Date.parse(value) : null;
    await database.prepare(
      `INSERT INTO tool_effects
         (effect_intent_id, run_id, attempt_epoch, tool_position, occurrence_key, tool_name,
          mode, request_hash, authority_revision, status, tool_call_id, connection_id,
          input_json, output_ref, output_summary, execution_plan_json, started_at, settled_at)
       VALUES (?, ?, 0, ?, ?, ?, ?, ?, 'runtime', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      String(receipt.harness_run_id),
      position,
      `runtime:${id}`,
      String(receipt.tool_name),
      plan?.includes('"mode":"write"') ? "write" : "read",
      String(receipt.input_hash ?? "seed"),
      // The object's own statuses. The retired view spelled the first two
      // `pending` and `started`, and the fixture still does.
      receipt.status === "pending" ? "admitted"
        : receipt.status === "started" ? "executing"
          : String(receipt.status),
      String(receipt.tool_call_id),
      receipt.connection_id ?? null,
      typeof receipt.input_json === "string" ? receipt.input_json : "{}",
      receipt.output_ref ?? null,
      receipt.output_summary ?? null,
      plan,
      at(receipt.started_at),
      at(receipt.completed_at),
    ).run();
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
  "automation_subscriptions", "schedules", "resources",
]);

const seedBody = z.object({
  workspaceId: z.string().uuid(),
  workspaceTables: z.record(z.string(), z.array(row)),
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
}).strict();

/** The route owns this shape; dev tooling has no member-facing contract. */
const SeedProductResultSchema = z.object({
  seeded: z.boolean(),
  workspaceTables: z.record(z.string(), z.number()),
  workstreams: z.array(z.object({
    workstreamId: z.string().uuid(),
    copied: z.record(z.string(), z.number()),
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
 * Seeds product-authority fixtures into the Durable Objects, through the same
 * runtime SQL ports every post-cutover producer writes through.
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
  if (c.env.APP_ENV !== "development" || c.env.AVALON_DEV_AUTH !== "true") {
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

    const insert = async (
      table: string,
      rows: z.infer<typeof row>[],
      extra: Record<string, string> = {},
    ) => {
      for (const record of rows) {
        const complete: Record<string, string | number | null> = { ...record, ...extra };
        const columns = Object.keys(complete);
        await routed.DB.prepare(
          `INSERT INTO ${table} (${columns.join(", ")})
           VALUES (${columns.map(() => "?").join(", ")})`,
        ).bind(...columns.map((column) => complete[column] ?? null)).run();
      }
      copied[table] = rows.length;
    };
    const scope = { workspace_id: workspaceId, workstream_id: workstream.id };
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
    await insert("harness_runs", workstream.harnessRuns, scope);
    await insertToolReceipts(routed.DB, workstream.toolInvocations, copied);
    await insert("messages", workstream.messages, scope);

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
  return { seeded: true, workspaceTables: workspaceCounts, workstreams: results };
}
