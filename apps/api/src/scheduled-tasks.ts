import { diagnosticErrorCode, logStructuredEvent, type LogEnv } from "./observability/logger";

/**
 * Runs independent maintenance tasks to completion and names every one that
 * failed.
 *
 * A tick's tasks share nothing, so one task's failure must neither stop the
 * others nor go unattributed. Each failure is logged as
 * `scheduled_task_failed` with the task's name and a diagnostic code; then the
 * call rejects, so the invocation still ends in an exception the platform
 * reports. A lone failure rejects with its own error, several with an
 * `AggregateError` whose message lists the tasks.
 */
export async function runScheduledTasks(
  env: LogEnv,
  tasks: Readonly<Record<string, () => Promise<unknown>>>,
): Promise<void> {
  const entries = Object.entries(tasks);
  // `then` rather than a direct call, so a task that throws before returning
  // its promise is settled with the rest instead of escaping `allSettled`.
  const results = await Promise.allSettled(entries.map(([, run]) => Promise.resolve().then(run)));
  const failed: Array<{ task: string; error: unknown }> = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") return;
    const task = entries[index]![0];
    failed.push({ task, error: result.reason });
    logStructuredEvent(env, "error", "scheduled_task_failed", {
      task,
      error_code: diagnosticErrorCode(result.reason, "scheduled_task_failed"),
    });
  });
  if (failed.length === 1) throw failed[0]!.error;
  if (failed.length > 1) {
    throw new AggregateError(
      failed.map(({ error }) => error),
      `scheduled_tasks_failed: ${failed.map(({ task }) => task).join(", ")}`,
    );
  }
}
