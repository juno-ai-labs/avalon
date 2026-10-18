import type {
  SearchEngineeringOrganizationsInput,
  SearchEngineeringUsersInput,
} from "@rally/contracts/engineering-inspection";
import { RegionSchema } from "@rally/contracts/regions";
import { z } from "zod";

import type { Env } from "./env";
import { WORKSTREAM_DO_SERVING_CONTRACT_VERSION } from "./services/workstream-authority";

export const InspectionWorkspaceRouteSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  region: RegionSchema,
  placement_affinity: z.string(),
  authority_state: z.literal("active"),
  authority_generation: z.number().int().positive(),
});
export type InspectionWorkspaceRoute = z.infer<typeof InspectionWorkspaceRouteSchema>;

export const InspectionWorkstreamRouteSchema = z.strictObject({
  workspace_id: z.string(),
  workstream_id: z.string(),
  authority_generation: z.number().int().positive(),
});
export type InspectionWorkstreamRoute = z.infer<typeof InspectionWorkstreamRouteSchema>;

type InspectionRouteEnv = Pick<Env, "AVALON_REGION" | "DB">;

/**
 * Resolve only a workspace that the regional Worker is currently allowed to
 * serve.
 *
 * WorkspaceDO names are deterministic from the regional workspace identity.
 * The region-wide authority control is the generation and serving-contract
 * fence; no per-workspace product route exists after the completed cutover.
 */
export async function resolveInspectionWorkspaceRoute(
  env: InspectionRouteEnv,
  workspaceId: string,
  expectedGeneration?: number,
): Promise<InspectionWorkspaceRoute | null> {
  const row = await env.DB.prepare(
    `SELECT workspace.id, workspace.name, workspace.slug, workspace.region,
            workspace.placement_affinity, 'active' AS authority_state,
            control.generation AS authority_generation
       FROM workspaces workspace
       JOIN workstream_authority_control control
         ON control.id = 1
        AND control.phase = 'durable_object_open'
        AND control.serving_contract_version >= control.required_serving_contract_version
        AND control.required_serving_contract_version <= ?
      WHERE workspace.id = ? AND workspace.region = ?
        AND (? IS NULL OR control.generation = ?)`,
  ).bind(
    WORKSTREAM_DO_SERVING_CONTRACT_VERSION,
    workspaceId,
    env.AVALON_REGION,
    expectedGeneration ?? null,
    expectedGeneration ?? null,
  ).first<unknown>();
  return row === null ? null : InspectionWorkspaceRouteSchema.parse(row);
}

/** Resolve only a route that the regional Worker is currently allowed to serve. */
export async function resolveInspectionWorkstreamRoute(
  env: InspectionRouteEnv,
  workstreamId: string,
  expectedGeneration?: number,
): Promise<InspectionWorkstreamRoute | null> {
  const row = await env.DB.prepare(
    `SELECT route.workspace_id, route.workstream_id,
            control.generation AS authority_generation
       FROM workstream_authority_routes route
       JOIN workstream_authority_control control
         ON control.id = 1
        AND control.phase = 'durable_object_open'
        AND control.serving_contract_version >= control.required_serving_contract_version
        AND control.required_serving_contract_version <= ?
        AND route.generation = control.generation
      WHERE route.workstream_id = ? AND route.state = 'active'
        AND (? IS NULL OR control.generation = ?)`,
  ).bind(
    WORKSTREAM_DO_SERVING_CONTRACT_VERSION,
    workstreamId,
    expectedGeneration ?? null,
    expectedGeneration ?? null,
  ).first<unknown>();
  return row === null ? null : InspectionWorkstreamRouteSchema.parse(row);
}

/**
 * Timestamps are stored as UTC ISO strings, so a bound is normalized to the
 * same form before the text comparison.
 */
function utcBound(value: string | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

/**
 * Case-insensitive substring match, run in JavaScript because SQLite's
 * `lower()` folds only ASCII, so `École` would not match `école`.
 */
function matchesQuery(query: string | undefined, fields: string[]): boolean {
  if (query === undefined) return true;
  const needle = query.toLowerCase();
  return fields.some((field) => field.toLowerCase().includes(needle));
}

const OrganizationRowSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  region: RegionSchema,
  plan: z.string(),
  created_at: z.string(),
  abandoned_at: z.string().nullable(),
  member_count: z.number().int().nonnegative(),
  last_seen_at: z.string().nullable(),
});
export type OrganizationRow = z.infer<typeof OrganizationRowSchema>;

/**
 * Every Organization in this region that matches the filters, unordered. The
 * caller merges the regions and orders the whole set.
 */
export async function searchInspectionOrganizations(
  env: InspectionRouteEnv,
  filter: SearchEngineeringOrganizationsInput,
): Promise<OrganizationRow[]> {
  const result = await env.DB.prepare(
    `SELECT workspace.id, workspace.name, workspace.slug, workspace.region, workspace.plan,
            workspace.created_at, workspace.abandoned_at,
            (SELECT COUNT(*) FROM workspace_members member
              WHERE member.workspace_id = workspace.id
                AND member.status = 'active' AND member.access_class = 'member') AS member_count,
            (SELECT MAX(member.last_seen_at) FROM workspace_members member
              WHERE member.workspace_id = workspace.id
                AND member.status = 'active') AS last_seen_at
       FROM workspaces workspace
      WHERE workspace.region = ?1
        AND (?2 IS NULL OR workspace.plan = ?2)
        AND CASE ?3
              WHEN 'include' THEN 1
              WHEN 'only' THEN workspace.abandoned_at IS NOT NULL
              ELSE workspace.abandoned_at IS NULL
            END
        AND (?4 IS NULL OR workspace.created_at >= ?4)
        AND (?5 IS NULL OR workspace.created_at < ?5)`,
  ).bind(
    env.AVALON_REGION,
    filter.plan ?? null,
    filter.abandoned ?? "exclude",
    utcBound(filter.createdAfter),
    utcBound(filter.createdBefore),
  ).all<unknown>();
  return z.array(OrganizationRowSchema).parse(result.results ?? [])
    .filter((row) => matchesQuery(filter.query, [row.name, row.slug, row.id]));
}

const UserMembershipSchema = z.strictObject({
  workspace_id: z.string(),
  name: z.string(),
  slug: z.string(),
  role: z.string().nullable(),
  access_class: z.string(),
  status: z.string(),
  last_seen_at: z.string().nullable(),
});

const UserRowSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  created_at: z.string(),
  last_seen_at: z.string().nullable(),
  memberships: z.string().transform((json) => z.array(UserMembershipSchema).parse(JSON.parse(json))),
});
export type UserRow = z.infer<typeof UserRowSchema>;

/**
 * Every user in this region that matches the filters, unordered, each with
 * every membership in this region's Organizations whatever its status. The
 * caller merges the regions and orders the whole set.
 */
export async function searchInspectionUsers(
  env: InspectionRouteEnv,
  filter: SearchEngineeringUsersInput,
): Promise<UserRow[]> {
  const result = await env.DB.prepare(
    `SELECT person.id, person.name, person.email, person.created_at,
            (SELECT json_group_array(json_object(
                      'workspace_id', workspace.id, 'name', workspace.name, 'slug', workspace.slug,
                      'role', member.role, 'access_class', member.access_class,
                      'status', member.status, 'last_seen_at', member.last_seen_at))
               FROM workspace_members member
               JOIN workspaces workspace ON workspace.id = member.workspace_id
              WHERE member.user_id = person.id AND workspace.region = ?1) AS memberships,
            (SELECT MAX(member.last_seen_at)
               FROM workspace_members member
               JOIN workspaces workspace ON workspace.id = member.workspace_id
              WHERE member.user_id = person.id AND workspace.region = ?1
                AND member.status = 'active') AS last_seen_at
       FROM users person
      WHERE (?2 IS NULL OR person.created_at >= ?2)
        AND (?3 IS NULL OR person.created_at < ?3)`,
  ).bind(
    env.AVALON_REGION,
    utcBound(filter.createdAfter),
    utcBound(filter.createdBefore),
  ).all<unknown>();
  return z.array(UserRowSchema).parse(result.results ?? [])
    .filter((row) => matchesQuery(filter.query, [row.name, row.email, row.id]));
}
