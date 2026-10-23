import type { LogEnv } from "../observability/logger";
import { diagnosticErrorCode, logInfo } from "../observability/logger";
import { inSpan } from "../observability/tracing";
import { SCHEDULED_ALARM_CANCELLATION_RECOVERY_MS } from "./scheduled-alarms";

export type WorkspaceScheduledAlarmPhase =
  | "recovery_rearm"
  | "authority_check"
  | "stored_target"
  | "activity_reap"
  | "connector_event_reap"
  | "space_default_publish"
  | "space_intent_resume"
  | "space_bootstrap"
  | "channel_color_sync"
  | "thread_backfill"
  | "import_reservation_reclaim"
  | "memory_digest_sync"
  | "schedule_reconcile"
  | "parent_outbox"
  | "parent_breakouts"
  | "directory_followup"
  | "final_rearm";

export type ObservableWorkspaceScheduledAlarmKind =
  | "product"
  | "schedule_bootstrap"
  | "personal_channel_backfill"
  | "schedule"
  | "watch"
  | "maintenance"
  | "terminal"
  | "parent_participant_projection"
  | "parent_participant_migration"
  | "parent_invitation_delivery"
  | "automation_schedule"
  | "automation_run"
  | "sidekick_memory_tables"
  | "sidekick_delegation_migration"
  | "sidekick_delegation_sources"
  | "unknown";

const OBSERVABLE_ALARM_KINDS = new Set<ObservableWorkspaceScheduledAlarmKind>([
  "product",
  "schedule_bootstrap",
  "personal_channel_backfill",
  "schedule",
  "watch",
  "maintenance",
  "terminal",
  "parent_participant_projection",
  "parent_participant_migration",
  "parent_invitation_delivery",
  "automation_schedule",
  "automation_run",
  "sidekick_memory_tables",
  "sidekick_delegation_migration",
  "sidekick_delegation_sources",
]);

export function observableWorkspaceScheduledAlarmKind(
  kind: string,
): ObservableWorkspaceScheduledAlarmKind {
  return OBSERVABLE_ALARM_KINDS.has(kind as ObservableWorkspaceScheduledAlarmKind)
    ? kind as ObservableWorkspaceScheduledAlarmKind
    : "unknown";
}

interface WorkspaceScheduledAlarmPhaseSample {
  phase: WorkspaceScheduledAlarmPhase;
  alarmKind: ObservableWorkspaceScheduledAlarmKind | undefined;
  durationMs: number;
  failed: boolean;
}

/**
 * Content-free phase timing for one WorkspaceDO alarm invocation.
 *
 * Cloudflare already attaches the Durable Object id and invocation id to each
 * row and span, so this deliberately records only bounded enums and numbers:
 * no workspace id, alarm key, due time, payload, connector data, or error
 * message. A start row without its completion row identifies the phase whose
 * continuation ended; the completion summary identifies the slowest phase in
 * an invocation that returned normally.
 */
export class WorkspaceAlarmInstrumentation {
  private readonly startedAt: number;
  private readonly samples: WorkspaceScheduledAlarmPhaseSample[] = [];
  private phaseCount = 0;
  private storedTargetCount = 0;

  constructor(
    private readonly env: LogEnv,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = this.now();
  }

  async phase<T>(
    phase: WorkspaceScheduledAlarmPhase,
    alarmKind: ObservableWorkspaceScheduledAlarmKind | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    const phaseIndex = ++this.phaseCount;
    if (phase === "stored_target") this.storedTargetCount += 1;
    const startedAt = this.now();
    const commonFields = {
      phase,
      phase_index: phaseIndex,
      ...(alarmKind === undefined ? {} : { alarm_kind: alarmKind }),
    };

    let failed = false;
    let phaseError: unknown;
    const result = await inSpan<T | undefined>("rally.workspace.scheduled_alarm.phase", {
      "rally.component": "workspace_do",
      "rally.alarm.phase": phase,
      "rally.alarm.phase_index": phaseIndex,
      "rally.alarm.kind": alarmKind,
    }, async (span) => {
      logInfo(this.env, "workspace_scheduled_alarm_phase_started", {
        status: "started",
        ...commonFields,
        alarm_elapsed_ms: Math.max(0, startedAt - this.startedAt),
      });
      try {
        const result = await run();
        const completedAt = this.now();
        const durationMs = Math.max(0, completedAt - startedAt);
        this.samples.push({ phase, alarmKind, durationMs, failed: false });
        const crossedRecoveryHorizon = durationMs >= SCHEDULED_ALARM_CANCELLATION_RECOVERY_MS;
        span.setAttributes({
          "rally.alarm.duration_ms": durationMs,
          "rally.alarm.crossed_recovery_horizon": crossedRecoveryHorizon,
        });
        logInfo(this.env, "workspace_scheduled_alarm_phase_completed", {
          status: "completed",
          ...commonFields,
          duration_ms: durationMs,
          alarm_elapsed_ms: Math.max(0, completedAt - this.startedAt),
          crossed_recovery_horizon: crossedRecoveryHorizon,
        });
        return result;
      } catch (error) {
        const failedAt = this.now();
        const durationMs = Math.max(0, failedAt - startedAt);
        this.samples.push({ phase, alarmKind, durationMs, failed: true });
        const crossedRecoveryHorizon =
          durationMs >= SCHEDULED_ALARM_CANCELLATION_RECOVERY_MS;
        span.setAttributes({
          "rally.alarm.duration_ms": durationMs,
          "rally.alarm.crossed_recovery_horizon": crossedRecoveryHorizon,
        });
        span.setError("workspace_scheduled_alarm_phase_failed");
        logInfo(this.env, "workspace_scheduled_alarm_phase_failed", {
          status: "failed",
          ...commonFields,
          duration_ms: durationMs,
          alarm_elapsed_ms: Math.max(0, failedAt - this.startedAt),
          crossed_recovery_horizon: crossedRecoveryHorizon,
          // Not every phase runs under the workspace's isolating wrapper, so
          // this may be the only record of why it failed. Only a code-shaped
          // message or a platform word crosses, never prose.
          error_name: error instanceof Error ? error.name : typeof error,
          code: diagnosticErrorCode(error, `${phase}_failed`),
        });
        // Cloudflare records errors thrown from an enterSpan callback. Keep the
        // original error in this outer closure so target ids or provider text
        // cannot become automatic trace fields, then rethrow after the custom
        // span has settled.
        failed = true;
        phaseError = error;
        return undefined;
      }
    });
    if (failed) throw phaseError;
    return result as T;
  }

  finish(): void {
    const completedAt = this.now();
    const slowest = this.samples.reduce<WorkspaceScheduledAlarmPhaseSample | null>(
      (current, sample) => current === null || sample.durationMs > current.durationMs
        ? sample
        : current,
      null,
    );
    const failedPhaseCount = this.samples.filter((sample) => sample.failed).length;
    const durationMs = Math.max(0, completedAt - this.startedAt);

    logInfo(this.env, "workspace_scheduled_alarm_work_completed", {
      status: failedPhaseCount === 0 ? "completed" : "completed_with_phase_failure",
      duration_ms: durationMs,
      phase_count: this.phaseCount,
      stored_target_count: this.storedTargetCount,
      failed_phase_count: failedPhaseCount,
      recovery_horizon_ms: SCHEDULED_ALARM_CANCELLATION_RECOVERY_MS,
      crossed_recovery_horizon: durationMs >= SCHEDULED_ALARM_CANCELLATION_RECOVERY_MS,
      ...(slowest === null ? {} : {
        slowest_phase: slowest.phase,
        slowest_phase_ms: slowest.durationMs,
        ...(slowest.alarmKind === undefined ? {} : {
          slowest_alarm_kind: slowest.alarmKind,
        }),
      }),
    });
  }
}
