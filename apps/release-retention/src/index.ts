import { logEvent } from "./logger";
import { runRetention } from "./retention";
import type { RetentionBindings } from "./retention";

interface Env extends RetentionBindings {
  RETENTION_DRY_RUN: string;
  RETENTION_KEEP_COUNT: string;
  RETENTION_LOCAL_HOUR: string;
  RETENTION_TIME_ZONE: string;
}

interface LocalTimeParts {
  date: string;
  hour: number;
  minute: number;
}

function localTimeParts(scheduledTime: number, timeZone: string): LocalTimeParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(new Date(scheduledTime));
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    hour: Number(value("hour")),
    minute: Number(value("minute")),
  };
}

export function shouldRunAtLocalHour(
  scheduledTime: number,
  timeZone: string,
  targetHour: number,
): boolean {
  const current = localTimeParts(scheduledTime, timeZone);
  if (current.minute !== 0) return false;
  if (current.hour === targetHour) return true;

  const previous = localTimeParts(scheduledTime - 60 * 60 * 1000, timeZone);
  return (
    current.date === previous.date &&
    current.hour === targetHour + 1 &&
    previous.hour === targetHour - 1
  );
}

function requiredInteger(value: string, name: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}`);
  }
  return parsed;
}

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    controller.noRetry();
    const localHour = requiredInteger(env.RETENTION_LOCAL_HOUR, "RETENTION_LOCAL_HOUR", 0);
    if (localHour > 23) throw new Error("RETENTION_LOCAL_HOUR must not exceed 23");
    if (!shouldRunAtLocalHour(controller.scheduledTime, env.RETENTION_TIME_ZONE, localHour)) {
      logEvent("info", "desktop_release_retention_skipped", {
        message: "desktop_release_retention_skipped not_target_local_hour",
        cron: controller.cron,
        reason: "not_target_local_hour",
        scheduled_time: new Date(controller.scheduledTime).toISOString(),
        time_zone: env.RETENTION_TIME_ZONE,
      });
      return;
    }

    const report = await runRetention(env, {
      dryRun: env.RETENTION_DRY_RUN === "true",
      keepCount: requiredInteger(env.RETENTION_KEEP_COUNT, "RETENTION_KEEP_COUNT", 1),
    });
    logEvent("info", "desktop_release_retention_completed", {
      message: `desktop_release_retention_completed ${report.status}`
        + ` archived=${report.archivedObjectCount} deleted=${report.deletedObjectCount}`,
      cron: controller.cron,
      report,
      scheduled_time: new Date(controller.scheduledTime).toISOString(),
      time_zone: env.RETENTION_TIME_ZONE,
    });
  },
} satisfies ExportedHandler<Env>;
