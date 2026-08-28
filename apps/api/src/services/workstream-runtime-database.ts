import { asWorkspaceId, asWorkstreamId } from "@rally/contracts";

import { substreamAgentName } from "../durable-objects/names";
import { rpcResultBody } from "../durable-objects/rpc-result";
import type { WorkstreamProvisionInput } from "../durable-objects/workstream-identity-storage";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { createIdentityObjectPort } from "../runtime/identity-port";
import { readWorkstreamAuthorityControl } from "./workstream-authority";

/**
 * Build the regional work-stream identity insert for the schema currently
 * deployed in this region.
 *
 * Migration 0090 is intentionally Worker-first: a destructive D1 migration
 * cannot run under the previous Worker, while the replacement Worker must
 * still be able to create work streams before both regions finish applying
 * the drop. Through 0089 the anchor table has required product columns; after
 * 0090 it has only the three routing columns. The values supplied to the old
 * shape are inert placeholders and are never read as product state.
 */
function finalRegionalWorkstreamAnchorStatement(
  env: Pick<Env, "DB">,
  workspaceId: string,
  workstreamId: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO workstreams (id, workspace_id, do_identity_anchor)
     VALUES (?, ?, 1)
     ON CONFLICT(id) DO NOTHING`,
  ).bind(workstreamId, workspaceId);
}

async function regionalWorkstreamAnchorStatement(
  env: Pick<Env, "DB">,
  workspaceId: string,
  workstreamId: string,
  at: string,
): Promise<{ legacyShape: boolean; statement: D1PreparedStatement }> {
  const legacyShape = await env.DB.prepare(
    `SELECT 1 AS legacy FROM pragma_table_info('workstreams')
      WHERE name = 'title' LIMIT 1`,
  ).first<{ legacy: number }>();
  if (!legacyShape) {
    return {
      legacyShape: false,
      statement: finalRegionalWorkstreamAnchorStatement(env, workspaceId, workstreamId),
    };
  }
  return {
    legacyShape: true,
    statement: env.DB.prepare(
      `INSERT INTO workstreams
         (id, workspace_id, title, objective, origin_type, harness_status,
          next_sequence_number, last_activity_at, created_at, updated_at,
          do_identity_anchor)
       VALUES (?, ?, ?, '', 'ad_hoc', 'idle', 1, ?, ?, ?, 1)
       ON CONFLICT(id) DO NOTHING`,
    ).bind(
      workstreamId,
      workspaceId,
      `[WorkstreamDO] ${workstreamId}`,
      at,
      at,
      at,
    ),
  };
}

/**
 * Commit an anchor with related route statements across the 0090 rollout.
 * D1 serializes each query, not the schema probe and the later batch together,
 * so 0090 may commit between them. In that one race the legacy insert is
 * re-prepared against the final shape and retried; every other error propagates.
 */
export async function writeRegionalWorkstreamAnchorBatch(
  env: Pick<Env, "DB">,
  input: { workspaceId: string; workstreamId: string; at: string },
  additionalStatements: () => D1PreparedStatement[],
): Promise<void> {
  const anchor = await regionalWorkstreamAnchorStatement(
    env,
    input.workspaceId,
    input.workstreamId,
    input.at,
  );
  try {
    await env.DB.batch([anchor.statement, ...additionalStatements()]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const migrationRemovedLegacyColumns =
      /(?:no such column|has no column named).*title|title.*(?:no such column|has no column named)/iu
        .test(reason);
    if (!anchor.legacyShape || !migrationRemovedLegacyColumns) throw error;
    await env.DB.batch([
      finalRegionalWorkstreamAnchorStatement(env, input.workspaceId, input.workstreamId),
      ...additionalStatements(),
    ]);
  }
}

/** Reserve the regional route and open one empty authoritative work-stream object. */
export async function bootstrapWorkstreamRuntimeEnvironment(
  env: Env,
  workspaceId: string,
  workstreamId: string,
): Promise<Env> {
  const authority = await readWorkstreamAuthorityControl(env);
  const at = new Date().toISOString();
  await writeRegionalWorkstreamAnchorBatch(env, { workspaceId, workstreamId, at }, () => [
    env.DB.prepare(
      `INSERT OR IGNORE INTO workstream_authority_routes
         (workspace_id, workstream_id, generation, object_name, state, stage_index,
          source_cursor, source_fence_sequence, source_hash, target_hash,
          row_counts_json, imported_at, verified_at, activated_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', 0, 0, 0, 'created_in_do', 'created_in_do',
               '{}', ?, ?, ?, ?)`,
    ).bind(
      workspaceId,
      workstreamId,
      authority.generation,
      `${env.AVALON_REGION}:${workspaceId}:${workstreamId}`,
      at,
      at,
      at,
      at,
    ),
  ]);
  const stub = await durableObjectStubForWorkspace(
    env,
    env.SUBSTREAM_AGENTS,
    workspaceId,
    substreamAgentName(env.AVALON_REGION, asWorkspaceId(workspaceId), asWorkstreamId(workstreamId)),
  );
  const response = await stub.bootstrapRuntime({
    workspaceId: asWorkspaceId(workspaceId),
    workstreamId: asWorkstreamId(workstreamId),
    generation: authority.generation,
  });
  if (response.status < 200 || response.status >= 300) {
    const body = rpcResultBody(response) as { error?: unknown } | null;
    throw new Error(typeof body?.error === "string" ? body.error : "workstream_runtime_bootstrap_failed");
  }
  // Product operations now use typed object ports. The caller keeps its
  // original environment instead of receiving a database-shaped authority
  // overlay whose table-name matcher silently chose a destination.
  return env;
}

/**
 * Write what a system-provisioned work stream is, on the object that owns it.
 *
 * The other half of {@link bootstrapWorkstreamRuntimeEnvironment}: that opens an
 * empty authoritative object, and this says what the work stream is and who can
 * see it. Automation, schedule, activity, and digest producers all use the same
 * typed identity operation rather than D1-shaped compatibility views.
 */
export async function provisionWorkstreamObject(
  env: Env,
  input: WorkstreamProvisionInput & { workspaceId: string; workstreamId: string },
): Promise<void> {
  await createIdentityObjectPort(env, input.workspaceId, input.workstreamId).provision(input);
}
