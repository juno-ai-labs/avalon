import { z } from "zod";

/**
 * Turning a schema rejection into something a log, a notice, or a caller on the
 * far side of an RPC hop can still read.
 *
 * A `ZodError` knows exactly what was wrong and where. Almost every way of
 * moving that knowledge anywhere loses it:
 *
 * - Across a Durable Object RPC boundary the serializer reduces it to a bare
 *   `Error` with no `issues`, no derived message and not even the name.
 * - Through `connectorObservationErrorCode` it becomes `unexpected_error`,
 *   because it is not a `ConnectorError`.
 * - Through `scheduledAlarmErrorCode` it becomes `handler_error`, because its
 *   message is a JSON blob rather than a code.
 *
 * Each of those is a real diagnosis thrown away at the boundary that was
 * supposed to report it. `docs/naming-a-schema-failure.md` records what that
 * cost and when to reach for this.
 *
 * What crosses every one of those boundaries is a short string. So these
 * helpers spend it on the two things that locate a defect — the path and the
 * issue code — and on nothing else.
 */

/**
 * The longest a diagnostic code may be and still read as one.
 *
 * Matched to `scheduledAlarmErrorCode`'s own bound, which is the narrowest
 * consumer: a message longer than this degrades to `handler_error` there, which
 * is the outcome with no signal in it.
 */
export const DIAGNOSTIC_CODE_MAX_LENGTH = 120;

/** How many issues a description names before it stops. */
const REPORTED_ISSUES = 3;

/** The whole value, when the rejection is about its shape rather than a field. */
const ROOT_PATH = "_root_";

const OUTSIDE_CODE_SHAPE = /[^A-Za-z0-9_:.-]/gu;

/**
 * One string reduced to what a code-shaped field will carry.
 *
 * Applied once to a finished message rather than to each part: a per-part
 * sanitizer is one branch away from being bypassed, and the first version of
 * this idea proved it by spelling the root path `(root)` in the one branch it
 * did not cover.
 */
export function codeShaped(text: string): string {
  return text.replace(OUTSIDE_CODE_SHAPE, "_").slice(0, DIAGNOSTIC_CODE_MAX_LENGTH);
}

/**
 * The failing paths and issue codes, and nothing else.
 *
 * Paths and issue codes are schema shape, not member data — the same line the
 * API's `errorHandler` already draws when it records `validation_issues` — so
 * they may be logged and may cross a boundary. The rejected *values* may not,
 * and are left behind.
 */
export function describeZodIssues(error: z.ZodError): string {
  const described = error.issues.slice(0, REPORTED_ISSUES).map((issue) => {
    const path = issue.path.length === 0 ? ROOT_PATH : issue.path.join(".");
    // `unrecognized_keys` is the one issue whose subject is not on its path:
    // Zod reports the offending names in `keys` and leaves `path` empty. That is
    // the version-skew shape, whose whole diagnosis is the field name.
    const keys = issue.code === "unrecognized_keys" ? `:${issue.keys.join(".")}` : "";
    return `${path}:${issue.code}${keys}`;
  });
  return described.join(":") || "no_issues";
}

/**
 * A schema rejection named as a code, or `null` for anything else.
 *
 * The `null` is what lets a caller keep its own vocabulary for every other
 * failure — a connector's `ConnectorError` code, an alarm handler's thrown
 * string — and reach for this only where it would otherwise have said
 * "something threw".
 */
export function zodDiagnosticCode(error: unknown, label: string): string | null {
  if (!(error instanceof z.ZodError)) return null;
  return codeShaped(`${label}_invalid:${describeZodIssues(error)}`);
}
