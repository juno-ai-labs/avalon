import type { Env } from "../env";
import { runScheduledTasks } from "../scheduled-tasks";
import {
  processCrashOutbox,
  purgeIneligibleCrashReports,
  reapExpiredCrashReports,
  reapExpiredOrphanedCrashObjects,
} from "./crash-delivery";
import { processPendingCrashReports } from "./crash-processing";

/**
 * One scheduled pass over native crash reports.
 *
 * Retention runs first but does not gate the rest: a transient R2 `list`
 * failure in the orphan sweep must not hold back the opt-out purge and
 * delivery. Its failure is held and rethrown once delivery is done.
 * The purge still gates processing and delivery, because a report whose owner
 * opted out must be deleted before anything else reads it.
 */
export async function processCrashTelemetry(env: Env): Promise<void> {
  const retention = await runScheduledTasks(env, {
    crash_report_retention: () => reapExpiredCrashReports(env),
    crash_object_retention: () => reapExpiredOrphanedCrashObjects(env),
  }).then(() => null, (error: unknown) => ({ error }));
  await purgeIneligibleCrashReports(env);
  await processPendingCrashReports(env);
  await processCrashOutbox(env);
  if (retention) throw retention.error;
}
