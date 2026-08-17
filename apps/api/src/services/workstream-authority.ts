import { z } from "zod";

import type { Env } from "../env";
import { ApiError } from "../lib/api-error";

export const WorkstreamAuthorityPhaseSchema = z.enum([
  "legacy_open",
  "maintenance_draining",
  "maintenance_importing",
  "maintenance_verified",
  "durable_object_open",
  "quarantined",
]);

export type WorkstreamAuthorityPhase = z.infer<typeof WorkstreamAuthorityPhaseSchema>;

export interface WorkstreamAuthorityControl {
  phase: WorkstreamAuthorityPhase;
  generation: number;
  requiredServingContractVersion: number;
  servingContractVersion: number;
}

/** This Worker implements the complete normalized WorkstreamDO serving contract. */
export const WORKSTREAM_DO_SERVING_CONTRACT_VERSION = 1;

const LEGACY_OPEN = {
  phase: "legacy_open",
  generation: 0,
  requiredServingContractVersion: 1,
  servingContractVersion: 0,
} as const satisfies WorkstreamAuthorityControl;

/**
 * Read the regional cutover fence.
 *
 * Missing-table fallback exists only for rollout ordering: the compatibility
 * Worker can deploy before D1 migration 0077. Every other database error is a
 * fail-closed maintenance state so an outage cannot accidentally reopen legacy
 * writers while an authority move is in progress.
 */
export async function readWorkstreamAuthorityControl(
  env: Pick<Env, "DB">,
): Promise<WorkstreamAuthorityControl> {
  try {
    const row = await env.DB.prepare(
      `SELECT phase, generation, required_serving_contract_version, serving_contract_version
         FROM workstream_authority_control WHERE id = 1`,
    ).first<{
      phase: string;
      generation: number;
      required_serving_contract_version: number;
      serving_contract_version: number;
    }>();
    if (!row) return {
      phase: "quarantined",
      generation: 0,
      requiredServingContractVersion: 1,
      servingContractVersion: 0,
    };
    return {
      phase: WorkstreamAuthorityPhaseSchema.parse(row.phase),
      generation: z.number().int().nonnegative().parse(row.generation),
      requiredServingContractVersion: z.number().int().positive()
        .parse(row.required_serving_contract_version),
      servingContractVersion: z.number().int().nonnegative().parse(row.serving_contract_version),
    };
  } catch (error) {
    if (error instanceof Error && /no such table: workstream_authority_control/iu.test(error.message)) {
      return LEGACY_OPEN;
    }
    return {
      phase: "quarantined",
      generation: 0,
      requiredServingContractVersion: 1,
      servingContractVersion: 0,
    };
  }
}

export function acceptsNewWorkstreamWork(control: WorkstreamAuthorityControl): boolean {
  return control.phase === "legacy_open" || (
    control.phase === "durable_object_open"
    && control.servingContractVersion >= control.requiredServingContractVersion
    && WORKSTREAM_DO_SERVING_CONTRACT_VERSION >= control.requiredServingContractVersion
  );
}

export function permitsLegacyRuntimeDrain(control: WorkstreamAuthorityControl): boolean {
  return control.phase === "legacy_open" || control.phase === "maintenance_draining";
}

/** Reject product ingress that reaches a named WorkerEntrypoint instead of the default HTTP handler. */
export async function requireWorkstreamIngress(
  env: Pick<Env, "DB">,
): Promise<WorkstreamAuthorityControl> {
  const control = await readWorkstreamAuthorityControl(env);
  if (!acceptsNewWorkstreamWork(control)) {
    throw new ApiError(503, "workstream_maintenance", "Work-stream maintenance is in progress");
  }
  return control;
}

export function workstreamMaintenanceResponse(control: WorkstreamAuthorityControl): Response {
  return Response.json({
    error: "workstream_maintenance",
    phase: control.phase,
    generation: control.generation,
  }, {
    status: 503,
    headers: {
      "Retry-After": "30",
      "Cache-Control": "no-store",
    },
  });
}
