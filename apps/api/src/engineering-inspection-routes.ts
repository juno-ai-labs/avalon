import { z } from "zod";

import type { Env } from "./env";
import { WORKSTREAM_DO_SERVING_CONTRACT_VERSION } from "./services/workstream-authority";

export const InspectionWorkspaceRouteSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  region: z.enum(["global", "eu"]),
  placement_affinity: z.string(),
  authority_state: z.literal("active"),
  authority_generation: z.number().int().positive(),
}).strict();
export type InspectionWorkspaceRoute = z.infer<typeof InspectionWorkspaceRouteSchema>;

export const InspectionWorkstreamRouteSchema = z.object({
  workspace_id: z.string(),
  workstream_id: z.string(),
  object_name: z.string(),
  authority_generation: z.number().int().positive(),
}).strict();
export type InspectionWorkstreamRoute = z.infer<typeof InspectionWorkstreamRouteSchema>;

type InspectionRouteEnv = Pick<Env, "AVALON_REGION" | "DB">;

/** Resolve only a route that the regional Worker is currently allowed to serve. */
export async function resolveInspectionWorkspaceRoute(
  env: InspectionRouteEnv,
  workspaceId: string,
  expectedGeneration?: number,
): Promise<InspectionWorkspaceRoute | null> {
  const row = await env.DB.prepare(
    `SELECT workspace.id, workspace.name, workspace.slug, workspace.region,
            workspace.placement_affinity, route.state AS authority_state,
            control.generation AS authority_generation
       FROM workspaces workspace
       JOIN workspace_product_authority_routes route
         ON route.workspace_id = workspace.id
        AND route.state = 'active'
       JOIN workstream_authority_control control
         ON control.id = 1
        AND control.phase = 'durable_object_open'
        AND control.serving_contract_version >= control.required_serving_contract_version
        AND control.required_serving_contract_version <= ?
        AND route.generation = control.generation
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
