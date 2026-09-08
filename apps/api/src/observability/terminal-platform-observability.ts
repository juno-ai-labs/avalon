import type { Env } from "../env";
import type { TerminalProviderOperationMeasurement } from "../services/terminal/provider-contract";
import { logStructuredEvent } from "./logger";

/**
 * One aggregate Daytona platform operation per point. This dataset deliberately
 * has a different grain from root-run analytics: it answers provider/image
 * latency questions and contains no tenant, run, command, path, or content ID.
 *
 * index1  terminal:region (the Analytics Engine sampling cohort)
 * blob1   schema_version
 * blob2   operation
 * blob3   outcome
 * blob4   region
 * blob5   snapshot
 * blob6   source_state
 * blob7   failure_phase
 * blob8   sorted comma-separated capabilities installed by the compatibility bootstrap, or none
 * blob9   app_version
 * blob10  build_sha
 * double1 end-to-end operation duration_ms
 * double2 provider create duration_ms
 * double3 policy read-back duration_ms
 * double4 compatibility installation duration_ms
 * double5 capability verification duration_ms
 * double6 installed capability count
 */
export const TERMINAL_PLATFORM_ANALYTICS_SCHEMA_VERSION = "terminal_platform_v1";

type TerminalPlatformEnv = Pick<
  Env,
  "TERMINAL_ANALYTICS" | "LOG_LEVEL" | "AVALON_REGION" | "APP_VERSION" | "BUILD_SHA"
>;

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function recordTerminalPlatformObservation(
  env: TerminalPlatformEnv,
  observation: TerminalProviderOperationMeasurement,
): void {
  const capabilities = [...new Set(observation.installedCapabilities)].sort();
  const missing = [...new Set(observation.missingCapabilities ?? [])].sort();
  const fields = {
    operation: observation.operation,
    state: observation.outcome,
    snapshot: observation.snapshot,
    source_state: observation.sourceState,
    failure_phase: observation.failurePhase,
    duration_ms: finiteNonNegative(observation.durationMs),
    provider_create_ms: finiteNonNegative(observation.providerCreateMs),
    policy_readback_ms: finiteNonNegative(observation.policyReadbackMs),
    install_duration_ms: finiteNonNegative(observation.installMs),
    verification_duration_ms: finiteNonNegative(observation.verifyMs),
    installed_capabilities: capabilities.length > 0 ? capabilities.join(",") : "none",
    installed_capability_count: capabilities.length,
    missing_capabilities: missing.length > 0 ? missing.join(",") : "none",
  };

  logStructuredEvent(
    env,
    observation.outcome === "completed" ? "info" : "warn",
    "terminal_daytona_operation_finished",
    fields,
  );

  try {
    env.TERMINAL_ANALYTICS.writeDataPoint({
      indexes: [`terminal:${env.AVALON_REGION}`],
      blobs: [
        TERMINAL_PLATFORM_ANALYTICS_SCHEMA_VERSION,
        observation.operation,
        observation.outcome,
        env.AVALON_REGION,
        observation.snapshot,
        observation.sourceState,
        observation.failurePhase,
        fields.installed_capabilities,
        env.APP_VERSION ?? "unknown",
        env.BUILD_SHA ?? "unknown",
      ],
      doubles: [
        fields.duration_ms,
        fields.provider_create_ms,
        fields.policy_readback_ms,
        fields.install_duration_ms,
        fields.verification_duration_ms,
        fields.installed_capability_count,
      ],
    });
  } catch (error) {
    // Analytics is advisory. It cannot change a provider operation that has
    // already succeeded or make a failed operation look recoverable.
    logStructuredEvent(env, "warn", "terminal_daytona_analytics_failed", {
      operation: observation.operation,
      state: observation.outcome,
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
  }
}
