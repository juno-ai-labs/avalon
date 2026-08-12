import {
  CONNECTOR_OFFERINGS,
  connectionMatchesOffering,
  type ConnectorCategory,
  type ConnectorOffering,
  type ExecutionPrincipal,
} from "@avalon/contracts";
import type { Env } from "../env";
import { connectorRegistryForEnv } from "../lib/connector-registry";
import { connectionIsEligibleForRun } from "../lib/connector-run-eligibility";
import { logStructuredEvent } from "../observability/logger";

/**
 * What a run is told about one offering it could be missing.
 *
 * Four states rather than a boolean, because "connected" is not one condition.
 * A connection made after this run was admitted is real, will show as connected
 * everywhere a person looks, and is still unusable here — the run's authority
 * was frozen at admission. A model told only "connected" in that case announces
 * it is sending the email and then calls a tool that does not exist.
 */
export type ConnectorOfferingState =
  | "not_connected"
  | "needs_reconnect"
  | "connected_not_yet_usable"
  | "connected";

export interface ConnectorOfferingReport {
  connector: string;
  name: string;
  description: string;
  categories: readonly ConnectorCategory[];
  scopes: readonly ("personal" | "workspace")[];
  state: ConnectorOfferingState;
  /** How to get past this state, when the state alone does not say. */
  hint?: string;
}

export interface FindConnectorOfferingsInput {
  workspaceId: string;
  harnessRunId: string;
  executionPrincipal: ExecutionPrincipal;
  categories?: readonly ConnectorCategory[];
  query?: string;
  /**
   * Include offerings that are connected and usable right now. Off by default:
   * this answers "what is missing", and a run's existing connections are
   * already in front of the model as loaded and loadable plugins. Turning it on
   * is for when somebody asks what they have.
   */
  includeConnected?: boolean;
}

const STATE_HINTS: Partial<Record<ConnectorOfferingState, string>> = {
  needs_reconnect:
    "A connection exists but the provider stopped honouring it. Offer it with core_show_connector_cards; the card asks to reconnect rather than to connect.",
  connected_not_yet_usable:
    "Connected, but after this run was admitted, so its tools are not available here. Do not claim to have used it. Say it is ready and that the next message will pick it up.",
};

function matchesQuery(offering: ConnectorOffering, query: string): boolean {
  const haystack = [
    offering.id,
    offering.name,
    offering.description,
    offering.connectorType,
    ...offering.categories,
  ].join(" ").toLowerCase();
  // Every word has to appear somewhere, so "google calendar" does not match the
  // Drive offering on "google" alone. Deliberately not an inference: this runs
  // inside a tool call the model is already waiting on.
  return query
    .toLowerCase()
    .split(/[^a-z0-9.+]+/u)
    .filter((term) => term.length > 1)
    .every((term) => haystack.includes(term));
}

/**
 * The connector types this region actually has credentials configured for.
 *
 * A registry that will not build must not take the feature with it: an offering
 * whose availability cannot be determined is reported, because the alternative
 * is silently telling somebody Avalon has no email connector. The same
 * fail-open choice, for the same reason, as `declaredConfidenceFloor` in
 * contextual routing.
 */
function configuredConnectorTypes(env: Env): ReadonlySet<string> | null {
  try {
    return new Set(connectorRegistryForEnv(env).list().map((manifest) => manifest.type));
  } catch {
    logStructuredEvent(env, "warn", "connector_registry_unavailable_for_recommendation", {});
    return null;
  }
}

/**
 * Which connectors could answer a need, and what stands between the run and
 * each of them.
 *
 * Deliberately not part of plugin discovery. `list_plugins` and `search_plugins`
 * answer "what can this run use", over the frozen scope, and their contract is
 * that everything they name is authority the run already holds. This answers
 * the opposite question — what it does *not* have — and mixing the two would
 * make a recommendation look loadable and a `load_plugin` call fail on it.
 */
export async function findConnectorOfferings(
  env: Env,
  input: FindConnectorOfferingsInput,
): Promise<ConnectorOfferingReport[]> {
  const [scopeRow, connectionRows] = await Promise.all([
    env.DB.prepare(
      `SELECT eligible_connection_ids_json FROM harness_run_scopes WHERE harness_run_id = ?`,
    ).bind(input.harnessRunId).first<{ eligible_connection_ids_json: string }>(),
    env.DB.prepare(
      `SELECT id, connector_type, scope, owner_user_id, status, granted_scopes_json
       FROM connector_connections
       WHERE workspace_id = ? AND status <> 'disabled'`,
    ).bind(input.workspaceId).all<Record<string, unknown>>(),
  ]);

  let usableConnectionIds: ReadonlySet<string>;
  try {
    usableConnectionIds = new Set(JSON.parse(scopeRow?.eligible_connection_ids_json ?? "[]") as string[]);
  } catch {
    usableConnectionIds = new Set();
  }

  // The same rule the plugin loader applies, so a personal connection belonging
  // to somebody else is invisible here exactly as it is there.
  const visible = (connectionRows.results ?? [])
    .filter((row) => connectionIsEligibleForRun(row, input.executionPrincipal))
    .map((row) => ({
      id: String(row.id),
      identity: {
        connectorType: String(row.connector_type),
        scope: row.scope === "workspace" ? ("workspace" as const) : ("personal" as const),
        grantedCapabilities: parseCapabilities(row.granted_scopes_json),
      },
      healthy: row.status === "healthy",
    }));

  const configured = configuredConnectorTypes(env);
  const categories = input.categories ?? [];
  const query = input.query?.trim() ?? "";

  const reports: ConnectorOfferingReport[] = [];
  for (const offering of CONNECTOR_OFFERINGS) {
    if (configured && !configured.has(offering.connectorType)) continue;
    if (categories.length > 0 && !categories.some((category) => offering.categories.includes(category))) continue;
    if (query && !matchesQuery(offering, query)) continue;

    const matches = visible.filter((connection) => connectionMatchesOffering(connection.identity, offering));
    const healthy = matches.filter((connection) => connection.healthy);
    const state: ConnectorOfferingState = healthy.some((connection) => usableConnectionIds.has(connection.id))
      ? "connected"
      : healthy.length > 0
        ? "connected_not_yet_usable"
        : matches.length > 0
          ? "needs_reconnect"
          : "not_connected";
    if (state === "connected" && !input.includeConnected) continue;

    const hint = STATE_HINTS[state];
    reports.push({
      connector: offering.id,
      name: offering.name,
      description: offering.description,
      categories: offering.categories,
      scopes: offering.scopes,
      state,
      ...(hint ? { hint } : {}),
    });
  }
  return reports;
}

function parseCapabilities(value: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
