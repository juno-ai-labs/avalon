import { z } from "zod";

import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { diagnosticErrorCode, logWarn, type LogEnv } from "../observability/logger";

export const WorkstreamAuthorityPhaseSchema = z.enum([
  "legacy_open",
  "maintenance_draining",
  "maintenance_importing",
  "maintenance_verified",
  "durable_object_open",
  "quarantined",
]);

/**
 * `unreadable` is never stored. It is what a read that failed returns: closed,
 * like `quarantined`, but not mistaken for an operator's quarantine in a log.
 */
export type WorkstreamAuthorityPhase = z.infer<typeof WorkstreamAuthorityPhaseSchema> | "unreadable";

export interface WorkstreamAuthorityControl {
  phase: WorkstreamAuthorityPhase;
  generation: number;
  requiredServingContractVersion: number;
  servingContractVersion: number;
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
 * Worker can deploy before D1 migration 0079. Every other failure, a D1 error
 * or a row that no longer parses, fails closed as `unreadable` and logs why.
 * It used to answer `quarantined` at generation 0, so a D1 overload read as
 * an operator's quarantine in every caller's log.
 *
 * It returns rather than throws because several callers are alarm deferrals,
 * where a throw spends the platform's alarm retries; a closed phase defers.
 */
export async function readWorkstreamAuthorityControl(
  env: Pick<Env, "DB"> & LogEnv,
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
    logWarn(env, "workstream_authority_unreadable", {
      code: diagnosticErrorCode(error, "workstream_authority_read_failed"),
    });
    return {
      phase: "unreadable",
      generation: 0,
      requiredServingContractVersion: 1,
      servingContractVersion: 0,
    };
  }
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
  env: Pick<Env, "DB"> & LogEnv,
): Promise<WorkstreamAuthorityControl> {
  const control = await readWorkstreamAuthorityControl(env);
  if (control.phase !== "durable_object_open") {
    throw new ApiError(
      503,
      "workstream_authority_not_open",
      "This deployment serves work streams from Durable Objects only; open the authority first (locally: pnpm db:open-authority)",
    );
  }
  return control;
}

/** Reject product ingress that reaches a named WorkerEntrypoint instead of the default HTTP handler. */
export async function requireWorkstreamIngress(
  env: Pick<Env, "DB"> & LogEnv,
): Promise<WorkstreamAuthorityControl> {
  const control = await readWorkstreamAuthorityControl(env);
  if (!acceptsNewWorkstreamWork(control)) {
    throw new ApiError(503, "workstream_maintenance", "Work-stream maintenance is in progress");
  }
  return control;
}
