/**
 * How every scheduling object reports an entry the base has gated.
 *
 * The retry gate holds an entry whether its handler threw or came back due at
 * the same instant, and `attempt` counts both: it is consecutive attempts
 * without progress. The reporting policy is therefore one policy, whichever
 * hook observed the attempt — a warning while it could still be a blip, an
 * error once it has held long enough to be a defect, and one operator
 * notification at exactly that threshold, so an episode that alternates
 * throws and stalls is still reported once. Each object supplies its own
 * identity fields and the `waitUntil` the notification rides on, because a
 * hook cannot await. `docs/durable-object-alarms.md` and `docs/ops-alerting.md`
 * are the module documents.
 */
import type { Env } from "../env";
import { logError, logWarn } from "../observability/logger";
import { notifyOps } from "../observability/ops-slack-notifier";

/**
 * Consecutive attempts without progress before an entry is reported outside
 * the log.
 *
 * One can be a race — a directory row the Queue has not caught up to — and
 * two a slow dependency. By the third the same entry has held across a couple
 * of minutes of growing backoff, which is a source the pass does not move or a
 * handler that cannot complete. The notification fires at this attempt
 * exactly, so one episode is one message however long it lasts.
 */
export const SCHEDULED_ALARM_ALERT_ATTEMPT = 3;

export interface ScheduledAlarmAttemptReport {
  /** The log event, and the notice's identity: `<object>_scheduled_alarm_failed` or `_stalled`. */
  event: string;
  /** What happened and where to look, in one sentence; the attempt and the hold are appended here. */
  summary: string;
  attempt: number;
  /** Identity only: ids, kinds, keys, codes. This text may leave Avalon. */
  fields: Record<string, string | number | boolean | null>;
}

/** The longest message `scheduledAlarmErrorCode` will carry through. */
export const SCHEDULED_ALARM_CODE_MAX_LENGTH = 120;

const OUTSIDE_CODE_SHAPE = /[^A-Za-z0-9_:.-]/gu;
const CODE_SHAPED = new RegExp(`^[a-z0-9_:.-]{1,${SCHEDULED_ALARM_CODE_MAX_LENGTH}}$`, "iu");

/**
 * One message reduced to what this module will carry, for a caller composing
 * a thrown message it wants to survive as a code.
 *
 * The bound and the character class live here rather than at each such caller,
 * because they are this module's contract: a caller restating them is one
 * regex edit away from silently degrading to `handler_error`, which is the
 * outcome with no signal in it. `:` survives as the separator a composed code
 * is built from.
 */
export function codeShaped(text: string): string {
  return text.replace(OUTSIDE_CODE_SHAPE, "_").slice(0, SCHEDULED_ALARM_CODE_MAX_LENGTH);
}

/**
 * A handler's error, reduced to something that may leave Avalon.
 *
 * A thrown message is a code in the cases that matter — `terminal_provider_unavailable`,
 * `r2_delete_failed` — but nothing guarantees it: a Zod issue list, a V8 parse
 * error quoting a stored row, a provider SDK's prose all arrive the same way.
 * The log row keeps the message; the notice carries it only when it has the
 * shape of a code, and names the error class otherwise.
 */
export function scheduledAlarmErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (CODE_SHAPED.test(message)) return message;
  return error instanceof Error && /^[A-Za-z]{1,60}$/u.test(error.name) ? `handler_error:${error.name}` : "handler_error";
}

export function reportScheduledAlarmAttempt(
  env: Env,
  waitUntil: (promise: Promise<unknown>) => void,
  report: ScheduledAlarmAttemptReport & { error?: unknown },
): void {
  const { error, ...rest } = report;
  // The row gets the message; the notice gets a code. Only a failure carries
  // an error at all.
  const logged = { ...rest.fields, attempt: rest.attempt, ...(error === undefined ? {} : { code: error instanceof Error ? error.message : "unknown_error" }) };
  const noticed = { ...rest.fields, attempt: rest.attempt, ...(error === undefined ? {} : { code: scheduledAlarmErrorCode(error) }) };
  if (rest.attempt < SCHEDULED_ALARM_ALERT_ATTEMPT) {
    logWarn(env, rest.event, logged);
    return;
  }
  logError(env, rest.event, logged);
  if (rest.attempt !== SCHEDULED_ALARM_ALERT_ATTEMPT) return;
  // The gate is already persisted; a notification lost to an eviction costs
  // one message, which is why it is not awaited.
  const summary = `${rest.summary} This is attempt ${rest.attempt} without progress; the entry is held behind its retry gate and retried up to every 30 minutes, and this message is not repeated while that continues.`;
  waitUntil(notifyOps(env, { event: rest.event, summary, fields: noticed }).catch(() => undefined));
}
