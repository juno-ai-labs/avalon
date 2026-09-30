import { z } from "zod";

import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { diagnosticErrorCode } from "../observability/logger";

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
  /**
   * Why the fence failed closed, when it was not read: the row is missing, or
   * the read failed. Absent for a phase the row itself holds. Without it a D1
   * outage and a real quarantine both read `quarantined:0`.
   */
  failedClosedReason?: string;
}

/**
 * This Worker implements the complete normalized object serving contract. The
 * name is from the deleted `WorkstreamDO`.
 */
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
 * Worker can deploy before D1 migration 0079. Every other database error is a
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
    if (!row) return failedClosed("authority_control_row_missing");
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
    return failedClosed(diagnosticErrorCode(error, "authority_control_read_failed"));
  }
}

function failedClosed(reason: string): WorkstreamAuthorityControl {
  return {
    phase: "quarantined",
    generation: 0,
    requiredServingContractVersion: 1,
    servingContractVersion: 0,
    failedClosedReason: reason,
  };
}

export function acceptsNewWorkstreamWork(control: WorkstreamAuthorityControl): boolean {
  return control.phase === "durable_object_open"
    && control.servingContractVersion >= control.requiredServingContractVersion
    && WORKSTREAM_DO_SERVING_CONTRACT_VERSION >= control.requiredServingContractVersion;
}

export function permitsLegacyRuntimeDrain(control: WorkstreamAuthorityControl): boolean {
  return control.phase === "maintenance_draining";
}

/**
 * Refuse to serve a work-stream product call anywhere but the Durable-Object
 * authority.
 *
 * The pre-cutover D1 execution arms are gone: production opened the authority
 * in both regions, and a local stack reaches the same state with
 * `pnpm db:open-authority`. A deployment that has not is an unsupported
 * configuration, and the honest answer is this refusal — not a silent run of
 * code no environment is meant to execute.
 */
export async function requireOpenWorkstreamAuthority(
  env: Pick<Env, "DB">,
): Promise<WorkstreamAuthorityControl> {
  const control = await readWorkstreamAuthorityControl(env);
  if (control.phase !== "durable_object_open") {
    throw new ApiError(
      503,
      "workstream_authority_not_open",
      "This deployment serves work streams from Durable Objects only; open the authority first (locally: pnpm db:open-authority)",
      undefined,
      control.failedClosedReason,
    );
  }
  return control;
}

/** Reject product ingress that reaches a named WorkerEntrypoint instead of the default HTTP handler. */
export async function requireWorkstreamIngress(
  env: Pick<Env, "DB">,
): Promise<WorkstreamAuthorityControl> {
  const control = await readWorkstreamAuthorityControl(env);
  if (!acceptsNewWorkstreamWork(control)) {
    throw new ApiError(
      503,
      "workstream_maintenance",
      "Work-stream maintenance is in progress",
      undefined,
      control.failedClosedReason,
    );
  }
  return control;
}
