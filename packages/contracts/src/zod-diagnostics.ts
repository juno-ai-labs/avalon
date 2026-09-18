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

/**
 * The whole value, when the rejection is about its shape rather than a field.
 *
 * Hyphenated so it cannot be confused with a field: a declared name is a
 * JavaScript identifier and so never contains one, and a key that did would be
 * withheld as `_key_` before it reached this comparison. A marker spelled
 * `_root_` is itself a legal object key, and the point of the marker is to say
 * that there was no key at all.
 */
const ROOT_PATH = "-root-";

/**
 * A path segment withheld because it is not a declared field name.
 *
 * `issue.path` is only schema shape when the schema declares its keys. Under
 * `z.record` the segments are keys from the rejected *value*, so a schema keyed
 * by email address, document title, or token would put that key into a log line,
 * a code crossing an RPC hop, and — through `scheduledAlarmErrorCode` — an
 * operator notice posted to Slack. Sanitizing and truncating it does not make it
 * non-sensitive; it makes it a recognizable value with the punctuation removed.
 *
 * Nothing on a `ZodIssue` says which kind of segment it is looking at, so the
 * shape of the segment decides: a declared property name in this tree is a
 * JavaScript identifier, and the values that matter here — addresses, titles,
 * ids, secrets — are not. That bounds the exposure rather than reasoning about
 * it, which is the trade a diagnostic should make.
 */
const WITHHELD_SEGMENT = "_key_";

/** What a declared property name looks like, and what a member's data does not. */
const DECLARED_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const OUTSIDE_CODE_SHAPE = /[^A-Za-z0-9_:.-]/gu;
const CODE_SHAPE = new RegExp(`^[A-Za-z0-9_:.-]{1,${DIAGNOSTIC_CODE_MAX_LENGTH}}$`, "u");

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
 * Whether a string already has the shape `codeShaped` reduces to.
 *
 * The test a boundary applies to a thrown message before copying it into an
 * indexed field or an operator notice. A message in this class carries no
 * whitespace and no punctuation beyond a separator, so it cannot be prose —
 * not a provider's sentence, not a member's content — and it is how a code a
 * Durable Object threw on purpose (`sidekick_missing`, or a `parseRpcInput`
 * rejection naming its field) is told apart from a message only a log row may
 * keep.
 *
 * One test rather than one per boundary. The alarm notice and the logger's
 * `diagnosticErrorCode` each spelled their own, and the second refused the
 * `:` and `.` the first accepted — so a rejection named on one side of an RPC
 * hop was reduced to its fallback on the other, by the helper that existed to
 * read it.
 */
export function isCodeShaped(text: string): boolean {
  return CODE_SHAPE.test(text);
}

/** The label-and-issues shape `zodDiagnosticCode` and `parseRpcInput` compose. */
const DIAGNOSTIC_CODE = /^[a-z][a-z0-9_]*_invalid:/u;

/**
 * Whether a message is one this module composed, rather than merely
 * code-shaped.
 *
 * `isCodeShaped` says a string cannot be prose. It does not say who wrote it:
 * `memory_table_value_type:${column.name}:string` passes it with a member's
 * column name in the middle, and so does an R2 key or a target id after a
 * colon. A reporter that reads a *thrown message* therefore admits an
 * arbitrary message only through the narrow constant class it always
 * trusted, and a message with separators only when it has the shape that
 * `zodDiagnosticCode` and `parseRpcInput` alone compose — a label,
 * `_invalid`, then the issues. That is provenance by construction rather than
 * proof: a thrown `x_invalid:${value}` would pass. It is the bound the first
 * adoption's reviewers asked for, and the reason a character class is never a
 * reason to trust a value, only a limit on what it can be.
 */
export function isDiagnosticCode(text: string): boolean {
  return isCodeShaped(text) && DIAGNOSTIC_CODE.test(text);
}

/**
 * The failing paths and issue codes, and nothing else.
 *
 * Paths and issue codes are schema shape, not member data — the same line the
 * API's `errorHandler` already draws when it records `validation_issues` — so
 * they may be logged and may cross a boundary. The rejected *values* may not,
 * and are left behind.
 */
export function describeZodIssues(
  error: z.ZodError,
  options: { readonly namesUnknownKeys?: boolean } = {},
): string {
  const described = error.issues.slice(0, REPORTED_ISSUES).map((issue) => {
    const path = issue.path.length === 0
      ? ROOT_PATH
      : issue.path.map(describeSegment).join(".");
    // `unrecognized_keys` is the one issue whose subject is not on its path:
    // Zod reports the offending names in `keys` and leaves `path` empty. Those
    // names come from the rejected object, so they are the caller's data unless
    // the caller is one this deployment controls. They are the whole diagnosis
    // of a version skew between our own components — and nothing at all worth
    // the risk on a provider's response.
    const keys = options.namesUnknownKeys === true && issue.code === "unrecognized_keys"
      ? `:${issue.keys.map(describeSegment).join(".")}`
      : "";
    return `${path}:${issue.code}${keys}`;
  });
  return described.join(":") || "no_issues";
}

/** An array index, a declared field name, or nothing. */
function describeSegment(segment: PropertyKey): string {
  if (typeof segment === "number") return String(segment);
  const name = String(segment);
  return DECLARED_NAME.test(name) ? name : WITHHELD_SEGMENT;
}

/**
 * A schema rejection named as a code, or `null` for anything else.
 *
 * The `null` is what lets a caller keep its own vocabulary for every other
 * failure — a connector's `ConnectorError` code, an alarm handler's thrown
 * string — and reach for this only where it would otherwise have said
 * "something threw".
 */
export function zodDiagnosticCode(
  error: unknown,
  label: string,
  options: { readonly namesUnknownKeys?: boolean } = {},
): string | null {
  if (!(error instanceof z.ZodError)) return null;
  return codeShaped(`${label}_invalid:${describeZodIssues(error, options)}`);
}
