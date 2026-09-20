/**
 * The regional D1 state an engineering inspection route resolves against.
 *
 * `resolveInspectionWorkspaceRoute` joins the workspace's identity columns to
 * the open generation. Historical workspaces additionally have a one-time
 * product-authority cutover row, while post-cutover workspaces do not. Every
 * Sidekick and artifact tool fences on that same resolution, so the suites seed
 * both shapes here rather than each keeping its own copy of the schema.
 */

import { seedWorkspaceControlPlane } from "./substream-fixture";

/**
 * Seed one workspace whose product authority route is active at the open
 * generation, plus the parent-route table the conversation runtime writes to.
 */
export async function seedInspectableWorkspace(
  database: D1Database,
  input: {
    workspaceId: string;
    userId: string;
    sessionId: string;
    at: string;
    includeHistoricalAuthorityRoute?: boolean;
  },
): Promise<void> {
  await seedWorkspaceControlPlane(database, input);
  await database.batch([
    // The inspection route reads identity columns the shared fixture's
    // workspaces table does not carry.
    database.prepare(`ALTER TABLE workspaces ADD COLUMN name TEXT NOT NULL DEFAULT 'Inspection workspace'`),
    database.prepare(`ALTER TABLE workspaces ADD COLUMN slug TEXT NOT NULL DEFAULT 'inspection-workspace'`),
    database.prepare(`ALTER TABLE workspaces ADD COLUMN placement_affinity TEXT NOT NULL DEFAULT 'wnam'`),
    database.prepare(`CREATE TABLE workspace_product_authority_routes (
      workspace_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, state TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    ...(input.includeHistoricalAuthorityRoute === false ? [] : [
      database.prepare(`INSERT INTO workspace_product_authority_routes
        (workspace_id, generation, state, updated_at) VALUES (?, 1, 'active', ?)`)
        .bind(input.workspaceId, input.at),
    ]),
    database.prepare(`CREATE TABLE IF NOT EXISTS workstreams (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, do_identity_anchor INTEGER NOT NULL DEFAULT 0
    )`),
    database.prepare(`CREATE TABLE IF NOT EXISTS workstream_authority_routes (
      workspace_id TEXT NOT NULL, workstream_id TEXT PRIMARY KEY, generation INTEGER NOT NULL,
      object_name TEXT NOT NULL, state TEXT NOT NULL, stage_index INTEGER NOT NULL DEFAULT 0,
      source_cursor INTEGER NOT NULL DEFAULT 0, source_fence_sequence INTEGER NOT NULL,
      source_hash TEXT, target_hash TEXT, row_counts_json TEXT, imported_at TEXT,
      verified_at TEXT, activated_at TEXT, last_error_code TEXT, updated_at TEXT NOT NULL
    )`),
  ]);
}

/**
 * A second workspace, equally open and active, for the cross-workspace fences.
 *
 * Only the rows: the tables are already there from the first call. It has to be
 * genuinely active, or a refusal proves nothing — it would come from the route
 * resolution rather than from the directory the fence is meant to consult.
 */
export async function seedSecondInspectableWorkspace(
  database: D1Database,
  input: { workspaceId: string; at: string },
): Promise<void> {
  await database.batch([
    database.prepare(`INSERT INTO workspaces(id, region) VALUES (?, 'global')`).bind(input.workspaceId),
    database.prepare(`INSERT INTO workspace_product_authority_routes
      (workspace_id, generation, state, updated_at) VALUES (?, 1, 'active', ?)`)
      .bind(input.workspaceId, input.at),
  ]);
}
