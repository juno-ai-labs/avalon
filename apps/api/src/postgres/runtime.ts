import { AvalonPostgresClient, type DatabaseRole } from "@avalon/postgres";

import type { Env } from "../env";

export type ProductDataAuthority = "d1" | "shadow" | "postgres";

export interface WorkspaceAuthorityDecision {
  authority: ProductDataAuthority;
  routeEpoch: number;
  sourceState: "writable" | "closing" | "closed" | "retired";
}

export const EXPECTED_POSTGRES_ROLE = {
  global_router: "avalon_global_router",
  regional_router: "avalon_regional_router",
  workflow_runner: "avalon_workflow_runner",
  queue_runner: "avalon_queue_runner",
} as const satisfies Record<DatabaseRole, string>;

// This list is deliberately compiled into the release rather than controlled
// by an environment flag. A secret/config toggle must not authorize a product
// authority before the named runtime surfaces exist and their tests remove the
// corresponding blocker in reviewed code.
export const POSTGRES_AUTHORITY_RUNTIME_BLOCKERS: readonly string[] = [
  "desktop regional Supabase session and Realtime transport",
  "production Bind plugin and Daytona reconciliation surface",
  "connector, derived-content, and maintenance queue consumers",
];

export function postgresAuthorityRuntimeReady(): boolean {
  return POSTGRES_AUTHORITY_RUNTIME_BLOCKERS.length === 0;
}

export function productDataAuthority(env: Env): ProductDataAuthority {
  return env.PRODUCT_DATA_AUTHORITY ?? "d1";
}

function hexBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/iu.test(value)) throw new Error("workspace_source_closure_hash_invalid");
  return Uint8Array.from(value.match(/.{2}/gu)!.map((pair) => Number.parseInt(pair, 16)));
}

/**
 * Resolve authority from the source-local linearization row, then prove the
 * destination activation receipt before selecting Postgres. The deployment
 * variable only enables a mode; it is never itself workspace authority.
 */
export async function resolveWorkspaceAuthority(
  env: Env,
  workspaceId: string,
): Promise<WorkspaceAuthorityDecision> {
  const gate = await env.DB.prepare(
    `SELECT authority_mode, source_state, route_epoch, source_closure_hash,
            destination_receipt_id
       FROM workspace_authority_gates WHERE workspace_id = ?`,
  ).bind(workspaceId).first<{
    authority_mode: ProductDataAuthority;
    source_state: WorkspaceAuthorityDecision["sourceState"];
    route_epoch: number;
    source_closure_hash: string | null;
    destination_receipt_id: string | null;
  }>();
  if (!gate || gate.authority_mode === "d1") {
    return { authority: "d1", routeEpoch: gate?.route_epoch ?? 1, sourceState: gate?.source_state ?? "writable" };
  }
  const enabled = productDataAuthority(env);
  if (gate.authority_mode === "shadow") {
    return {
      // Shadow evidence never becomes read/write authority. Until the explicit
      // comparison adapter exists, D1 remains the only path even when the gate
      // records that the workspace is eligible for shadowing.
      authority: "d1",
      routeEpoch: gate.route_epoch,
      sourceState: gate.source_state,
    };
  }
  if (enabled !== "postgres") throw new Error("workspace_postgres_authority_runtime_disabled");
  if (!postgresAuthorityRuntimeReady()) {
    throw new Error("workspace_postgres_authority_runtime_not_ready");
  }
  if ((gate.source_state !== "closed" && gate.source_state !== "retired")
      || !gate.source_closure_hash || !gate.destination_receipt_id) {
    throw new Error("workspace_postgres_authority_source_closure_missing");
  }
  const client = createPostgresClient(env, "regional_router");
  try {
    const destination = await client.workspaceAuthorityDescriptor({
      workspaceId,
      expectedRouteEpoch: gate.route_epoch,
      sourceClosureHash: hexBytes(gate.source_closure_hash),
    });
    if (!destination.writable || destination.workspace_id !== workspaceId
        || destination.route_epoch !== gate.route_epoch) {
      throw new Error("workspace_postgres_authority_destination_receipt_mismatch");
    }
  } finally {
    await client.close();
  }
  return { authority: "postgres", routeEpoch: gate.route_epoch, sourceState: gate.source_state };
}

function connectionStringForRole(env: Env, role: DatabaseRole): string {
  const value = role === "global_router"
    ? env.SUPABASE_GLOBAL_ROUTER_DATABASE_URL
    : role === "regional_router"
      ? env.SUPABASE_REGIONAL_ROUTER_DATABASE_URL
      : role === "workflow_runner"
        ? env.SUPABASE_WORKFLOW_DATABASE_URL
        : env.SUPABASE_QUEUE_DATABASE_URL;
  if (!value) throw new Error(`supabase_${role}_database_url_required`);
  return value;
}

export function createPostgresClient(env: Env, role: DatabaseRole): AvalonPostgresClient {
  return new AvalonPostgresClient({
    connectionString: connectionStringForRole(env, role),
    role,
    ssl: env.SUPABASE_DATABASE_SSL !== "disable",
    applicationName: `avalon-${env.AVALON_REGION}-${role}`,
  });
}

export function postgresHealthRoles(env: Env): DatabaseRole[] {
  const roles: DatabaseRole[] = ["regional_router", "workflow_runner", "queue_runner"];
  if (env.AVALON_REGION === "global") roles.push("global_router");
  return roles;
}

export function assertPostgresAuthorityConfigured(env: Env): void {
  const authority = productDataAuthority(env);
  if (authority === "d1") return;
  const required = [
    env.SUPABASE_REGIONAL_ROUTER_DATABASE_URL,
    env.SUPABASE_WORKFLOW_DATABASE_URL,
    env.SUPABASE_QUEUE_DATABASE_URL,
  ];
  if (env.AVALON_REGION === "global") required.push(env.SUPABASE_GLOBAL_ROUTER_DATABASE_URL);
  if (required.some((value) => !value)) throw new Error("supabase_postgres_role_urls_required");
}
