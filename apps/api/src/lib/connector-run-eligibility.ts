import type { ExecutionPrincipal } from "@avalon/contracts";

/**
 * The columns of a `connector_connections` row this rule reads. Optional
 * because both callers hand it a whole untyped D1 row, and a row missing them
 * must fail closed rather than fail to compile at one call site and not the
 * other.
 */
export interface ConnectorRunEligibilityRow {
  scope?: unknown;
  owner_user_id?: unknown;
}

/**
 * Whether a run may use a connection at all.
 *
 * A workspace connection is an organization capability every run in the
 * workspace receives. A personal one belongs to its owner alone, so only a run
 * executing as that person may see it — a workspace-principal run must never
 * reach a member's personal credential
 * ([`CONNECTORS.md`](../../../../docs/CONNECTORS.md#authorization-model)).
 *
 * Extracted because two callers now depend on it and they must not disagree.
 * `loadHarnessTools` uses it to decide which connector plugins a run gets;
 * `findConnectorOfferings` uses it to decide which connections a model is told
 * about when it asks what is missing. A recommendation rule that were looser
 * than the loading rule would answer "you already have a calendar" by
 * describing a colleague's private connection — a disclosure, and a dead end,
 * because the run could not have used it either.
 */
export function connectionIsEligibleForRun(
  row: ConnectorRunEligibilityRow,
  principal: ExecutionPrincipal,
): boolean {
  const scope = row.scope === "workspace" ? "workspace" : "personal";
  if (scope === "workspace") return true;
  return principal.type === "user" && row.owner_user_id === principal.userId;
}
