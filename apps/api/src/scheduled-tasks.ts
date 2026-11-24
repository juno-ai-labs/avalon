import { diagnosticErrorCode, logStructuredEvent, type LogEnv } from "./observability/logger";

/** Failures an inner runner has already logged, so an outer one does not repeat them. */
const logged = new WeakSet<object>();

/**
 * Runs independent maintenance tasks to completion and names every one that
 * failed.
 *
 * A tick's tasks share nothing, so one task's failure must neither stop the
 * others nor go unattributed. Each failure is logged once, as
 * `scheduled_task_failed` with the innermost task name and a diagnostic code;
 * a runner nested inside another runner's task leaves the outer one nothing
 * to repeat. Then the call rejects, so the invocation still ends in an
 * exception the platform reports: with the task's own error when one failed,
 * or an `AggregateError` listing the tasks when several did.
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
    const error: unknown = result.reason;
    failed.push({ task, error });
    if (typeof error === "object" && error !== null && logged.has(error)) return;
    logStructuredEvent(env, "error", "scheduled_task_failed", {
      task,
      error_code: diagnosticErrorCode(error, "scheduled_task_failed"),
    });
    if (typeof error === "object" && error !== null) logged.add(error);
  });
  if (failed.length === 1) throw failed[0]!.error;
  if (failed.length > 1) {
    const aggregate = new AggregateError(
      failed.map(({ error }) => error),
      `scheduled_tasks_failed: ${failed.map(({ task }) => task).join(", ")}`,
    );
    logged.add(aggregate);
    throw aggregate;
  }
}
