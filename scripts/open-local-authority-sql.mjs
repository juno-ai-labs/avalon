export const localAuthorityRegions = ["global", "eu"];

export function localAuthorityTarget(region) {
  if (!localAuthorityRegions.includes(region)) throw new TypeError("region must be global or eu");
  return {
    baseUrl: region === "global" ? "http://127.0.0.1:8787" : "http://127.0.0.1:8788",
    config: `wrangler.${region}.jsonc`,
    state: `.wrangler/state/${region}`,
  };
}

export function workspaceProductAuthorityRouteUpsertSql(generation) {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new TypeError("generation must be a non-negative safe integer");
  }
  return `INSERT INTO workspace_product_authority_routes (
    workspace_id, generation, state, stage_index, source_cursor,
    row_counts_json, last_error_code, updated_at
  )
  SELECT id, ${generation}, 'pending', 0, 0, '{}', NULL,
         strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM workspaces
  WHERE 1
  ON CONFLICT(workspace_id) DO UPDATE SET
    generation=excluded.generation, state='pending', stage_index=0,
    source_cursor=0, row_counts_json='{}', last_error_code=NULL,
    updated_at=excluded.updated_at`;
}
