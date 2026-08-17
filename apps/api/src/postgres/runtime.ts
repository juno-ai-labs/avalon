import { AvalonPostgresClient, type DatabaseRole } from "@avalon/postgres";

import type { Env } from "../env";

export type ProductDataAuthority = "d1" | "shadow" | "postgres";

export const EXPECTED_POSTGRES_ROLE = {
  global_router: "avalon_global_router",
  regional_router: "avalon_regional_router",
  workflow_runner: "avalon_workflow_runner",
  queue_runner: "avalon_queue_runner",
} as const satisfies Record<DatabaseRole, string>;

export function productDataAuthority(env: Env): ProductDataAuthority {
  return env.PRODUCT_DATA_AUTHORITY ?? "d1";
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
