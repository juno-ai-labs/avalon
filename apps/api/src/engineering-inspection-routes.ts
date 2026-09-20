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
  object_name: z.string(),
  authority_generation: z.number().int().positive(),
});
export type InspectionWorkstreamRoute = z.infer<typeof InspectionWorkstreamRouteSchema>;

type InspectionRouteEnv = Pick<Env, "AVALON_REGION" | "DB">;

/**
 * Resolve only a workspace that the regional Worker is currently allowed to
 * serve.
 *
 * `workspace_product_authority_routes` is the retained one-time cutover
 * ledger. The cutover seeded every workspace that existed at the time, then
 * removed the trigger that populated this table. A missing row therefore
 * identifies a workspace created directly in WorkspaceDO authority after the
 * cutover; its regional `workspaces` identity is the route. When a historical
 * row does exist, it remains a fence and must be active in the open generation.
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
       LEFT JOIN workspace_product_authority_routes route
         ON route.workspace_id = workspace.id
       JOIN workstream_authority_control control
         ON control.id = 1
        AND control.phase = 'durable_object_open'
        AND control.serving_contract_version >= control.required_serving_contract_version
        AND control.required_serving_contract_version <= ?
      WHERE workspace.id = ? AND workspace.region = ?
        AND (route.workspace_id IS NULL OR (
          route.state = 'active' AND route.generation = control.generation
        ))
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
    `SELECT route.workspace_id, route.workstream_id, route.object_name,
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
