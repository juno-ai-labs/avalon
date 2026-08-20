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

const row = z.record(z.string(), z.union([z.string(), z.number(), z.null()]));

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

    await routed.DB.prepare(
      `UPDATE workstreams SET title = ?, harness_status = ?, next_sequence_number = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              last_activity_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND workspace_id = ?`,
    ).bind(
      workstream.title,
      workstream.harnessStatus,
      workstream.nextSequenceNumber,
      workstream.id,
      workspaceId,
    ).run();

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
    await insert("workstream_participants", workstream.participants, { workstream_id: workstream.id });
    await insert("harness_runs", workstream.harnessRuns, scope);
    await insert("tool_invocations", workstream.toolInvocations, scope);
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
