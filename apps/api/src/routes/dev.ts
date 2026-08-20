import { Hono } from "hono";
import { asUserId, asWorkspaceId, asWorkstreamId } from "@avalon/contracts";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";

import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import {
  bootstrapWorkstreamRuntimeEnvironment,
  regionalDatabase,
} from "../services/workstream-runtime-database";
import { withWorkspaceRuntimeDatabase } from "../services/workspace-runtime-database";
import { readWorkstreamAuthorityControl } from "../services/workstream-authority";
import { WorkstreamObjectClient } from "../services/workstream-object-client";

const importBody = z.object({
  workspaceId: z.string().uuid(),
  workstreamId: z.string().uuid(),
}).strict();

/** The route owns this shape; dev tooling has no member-facing contract. */
const SeedImportResultSchema = z.object({
  imported: z.boolean(),
  workspaceId: z.string().uuid().optional(),
  workstreamId: z.string().uuid().optional(),
  copied: z.record(z.string(), z.number()).optional(),
}).strict();

export const devRoutes = new Hono<{ Bindings: Env }>();

/**
 * Imports one legacy-seeded work stream into its Durable Object, through the
 * same runtime SQL port every post-cutover producer writes through.
 *
 * Local development only. `packages/db/seed.sql` writes work-stream product
 * rows into D1 — the pre-cutover authority — and `pnpm db:open-authority`
 * fences them without importing them, because the production import campaign
 * was retired after the cutover. Without this, the seed fixtures the smoke
 * check asserts (transcript, tool events, right-rail resources) sit fenced in
 * D1 behind an empty object, and `pnpm smoke:local` fails on any stack that
 * has been opened. The route reads the legacy rows from regional D1 and
 * replays them through the routed environment, whose compat views own the
 * translation — no second copy of the mapping exists here.
 *
 * Guarded exactly like `/auth/dev/session`, and additionally refused unless
 * the authority is already open: importing into a legacy-phase stack would
 * write nothing anyone reads.
 */
devRoutes.post("/import-seed-workstream", zValidator("json", importBody), async (c) => {
  if (c.env.APP_ENV !== "development" || c.env.AVALON_DEV_AUTH !== "true") {
    throw new ApiError(404, "not_found", "Development tooling is unavailable");
  }
  const { workspaceId, workstreamId } = c.req.valid("json");
  try {
    return await importSeedWorkstream(c.env, workspaceId, workstreamId, (body) => c.json(SeedImportResultSchema.parse(body)));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // A development tool's failure detail belongs in its response; the global
    // handler's member-safe 500 was built for members, not for the person
    // debugging their own local stack.
    throw new ApiError(500, "seed_import_failed",
      error instanceof Error ? error.message.slice(0, 400) : "unknown");
  }
});

async function importSeedWorkstream(
  envInput: Env,
  workspaceId: string,
  workstreamId: string,
  json: (body: z.infer<typeof SeedImportResultSchema>) => Response,
): Promise<Response> {
  const authority = await readWorkstreamAuthorityControl(envInput);
  if (authority.phase !== "durable_object_open") {
    throw new ApiError(409, "authority_not_open", "Run pnpm db:open-authority first");
  }

  // `bootstrapWorkstreamRuntimeEnvironment` returns the already-routed
  // environment; wrapping it again would bury the regional escape hatch one
  // proxy deep and route the legacy reads back into the object.
  const routed = await bootstrapWorkstreamRuntimeEnvironment(envInput, workspaceId, workstreamId);
  const legacy = regionalDatabase(routed);

  const read = async (sql: string) =>
    (await legacy.prepare(sql).bind(workstreamId).all<Record<string, unknown>>()).results ?? [];
  const copied: Record<string, number> = {};
  const copy = async (
    table: string,
    rows: Record<string, unknown>[],
    columns: string[],
  ) => {
    for (const row of rows) {
      await routed.DB.prepare(
        `INSERT INTO ${table} (${columns.join(", ")})
         VALUES (${columns.map(() => "?").join(", ")})`,
      ).bind(...columns.map((column) => row[column] ?? null)).run();
    }
    copied[table] = rows.length;
  };

  // The work stream's own row: the bootstrap wrote a placeholder; the legacy
  // row carries the real title, objective, and state.
  const [workstream] = await read(
    `SELECT title, objective, harness_status FROM workstreams WHERE id = ?`,
  );
  if (!workstream) {
    throw new ApiError(404, "seed_workstream_missing", "Run pnpm db:seed first");
  }
  await routed.DB.prepare(
    `UPDATE workstreams SET title = ?, harness_status = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            last_activity_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND workspace_id = ?`,
  ).bind(
    workstream.title,
    // Seed states like `running` describe a run whose executor never existed
    // post-import; land idle so nothing waits on a phantom.
    workstream.harness_status === "running" ? "idle" : workstream.harness_status,
    workstreamId,
    workspaceId,
  ).run();

  await copy("workstream_participants", await read(
    `SELECT workstream_id, user_id, added_by_user_id, participation_reason, joined_at
       FROM workstream_participants WHERE workstream_id = ? AND removed_at IS NULL`,
  ), ["workstream_id", "user_id", "added_by_user_id", "participation_reason", "joined_at"]);

  await copy("harness_runs", await read(
    `SELECT id, workspace_id, workstream_id, origin, execution_principal_json, status,
            started_at, completed_at, terminalized_at, created_at
       FROM harness_runs WHERE workstream_id = ?`,
  ), ["id", "workspace_id", "workstream_id", "origin", "execution_principal_json",
    "status", "started_at", "completed_at", "terminalized_at", "created_at"]);

  await copy("messages", await read(
    `SELECT id, client_message_id, workspace_id, workstream_id, author_type,
            author_user_id, message_type, text_content, structured_content_json,
            sequence_number, created_at, harness_run_id
       FROM messages WHERE workstream_id = ? ORDER BY sequence_number`,
  ), ["id", "client_message_id", "workspace_id", "workstream_id", "author_type",
    "author_user_id", "message_type", "text_content", "structured_content_json",
    "sequence_number", "created_at", "harness_run_id"]);

  // Resources go through the product attach flow rather than the view: the
  // view has no INSERT trigger by design, because a link row carries the
  // workspace resource snapshot that only the product flow can supply.
  const resourceRows = await read(
    `SELECT resource_id FROM workstream_resources WHERE workstream_id = ?`,
  );
  const participants = await read(
    `SELECT user_id FROM workstream_participants WHERE workstream_id = ? AND removed_at IS NULL`,
  );
  // Connections are workspace-authority state the right rail reads; the seed
  // wrote them only to legacy D1. Identical columns, straight copy.
  const connectionColumns = [
    "id", "workspace_id", "connector_type", "scope", "owner_user_id",
    "provider_account_id", "display_name", "encrypted_credentials",
    "credential_iv", "credential_key_version", "credential_refresh_lease_id",
    "credential_refresh_lease_expires_at", "granted_scopes_json", "status",
    "cursor_json", "config_json", "last_sync_at", "next_poll_at", "error_json",
    "created_at", "updated_at", "model_plugin_id",
  ];
  const workspaceDatabase = withWorkspaceRuntimeDatabase(envInput, workspaceId);
  const legacyConnections = (await legacy.prepare(
    `SELECT ${connectionColumns.join(", ")} FROM connector_connections WHERE workspace_id = ?`,
  ).bind(workspaceId).all<Record<string, unknown>>()).results ?? [];
  for (const connection of legacyConnections) {
    await workspaceDatabase.DB.prepare(
      `INSERT OR IGNORE INTO connector_connections (${connectionColumns.join(", ")})
       VALUES (${connectionColumns.map(() => "?").join(", ")})`,
    ).bind(...connectionColumns.map((column) => connection[column] ?? null)).run();
  }
  copied.connector_connections = legacyConnections.length;

  const attachAs = String(participants[0]?.user_id ?? "");
  if (resourceRows.length > 0 && attachAs) {
    // The attach flow reads the resource from the workspace authority, so the
    // legacy resource rows must land in the WorkspaceDO first — the same
    // import, one authority up, through the workspace runtime router.
    const resourceColumns = [
      "id", "workspace_id", "connection_id", "resource_type", "provider",
      "provider_resource_id", "title", "mime_type", "content_ref", "canonical_url",
      "metadata_json", "last_hydrated_at", "created_at", "updated_at",
      "uploaded_by_user_id", "attachment_status",
    ];
    const legacyResources = (await legacy.prepare(
      `SELECT ${resourceColumns.join(", ")} FROM resources
        WHERE id IN (${resourceRows.map(() => "?").join(", ")})`,
    ).bind(...resourceRows.map((row) => row.resource_id)).all<Record<string, unknown>>()).results ?? [];
    for (const resource of legacyResources) {
      await workspaceDatabase.DB.prepare(
        `INSERT OR IGNORE INTO resources (${resourceColumns.join(", ")})
         VALUES (${resourceColumns.map(() => "?").join(", ")})`,
      ).bind(...resourceColumns.map((column) => resource[column] ?? null)).run();
    }
    const client = new WorkstreamObjectClient(envInput, {
      sessionId: "development",
      userId: asUserId(attachAs),
      workspaceId: asWorkspaceId(workspaceId),
      region: envInput.AVALON_REGION,
      role: "owner",
    }, workstreamId);
    for (const row of resourceRows) {
      // Re-runs repair partial imports; an attachment that already exists is
      // that repair finding nothing to do.
      await client.attachResource(String(row.resource_id)).catch((error: unknown) => {
        const code = error instanceof ApiError ? error.code : "";
        if (code !== "resource_already_attached" && code !== "conflict") throw error;
      });
    }
  }
  copied.workstream_resources = resourceRows.length;

  return json({
    imported: true,
    workspaceId: asWorkspaceId(workspaceId),
    workstreamId: asWorkstreamId(workstreamId),
    copied,
  });
}
