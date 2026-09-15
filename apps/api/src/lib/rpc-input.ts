import type { z } from "zod";

/**
 * How many issues a rejection names before it stops.
 *
 * The first few locate the defect; a projection with thirty bad evaluators is
 * one bug, and listing all thirty only pushes the message past the length at
 * which it still reads as a code.
 */
const REPORTED_ISSUES = 3;

/**
 * The whole value, when the rejection is about its shape rather than a field.
 *
 * Underscored rather than parenthesized so it passes `scheduledAlarmErrorCode`
 * on its own terms; a bare `root` would be indistinguishable from a field of
 * that name.
 */
const ROOT_PATH = "_root_";

/** Issue paths and codes, before the message is reduced to a code shape. */
function describeIssues(error: z.ZodError): string {
  const described = error.issues.slice(0, REPORTED_ISSUES).map((issue) => (
    `${issue.path.length === 0 ? ROOT_PATH : issue.path.join(".")}:${issue.code}`
  ));
  return described.join(":") || "no_issues";
}

/**
 * Everything `scheduledAlarmErrorCode` will pass through, and nothing else.
 *
 * Applied once to the finished message rather than to each part, because a
 * per-part sanitizer is one branch away from being bypassed — the first version
 * of this file spelled the root path `(root)`, sanitized only the other branch,
 * and so degraded exactly the whole-value shape mismatch a version skew
 * produces back to `handler_error`. `:` survives because it is the separator;
 * a path segment carrying one reads as an extra field, which is a worse message
 * than a substituted character and not a lost one.
 */
function codeShaped(message: string): string {
  return message.replace(/[^A-Za-z0-9_:.-]/gu, "_");
}

/**
 * Parse one Durable Object RPC method's input so a rejection survives the hop.
 *
 * A `ZodError` does not cross an RPC boundary. The serializer reduces it to a
 * plain `Error` carrying no `issues`, no message and not even the name —
 * `structuredClone` of one keeps `stack` and nothing else — so the calling
 * object logs the bare word `ZodError` and stops. That named neither the
 * field, nor the schema, nor which of a handler's several parses failed.
 *
 * It cost a day in production: a Sidekick's `sidekick_publication` alarm threw
 * here on every attempt, so its external-event registrations were never
 * written and its trigger never fired, while the Sidekick showed as published
 * and the only evidence was `sidekick_scheduled_alarm_failed ZodError`.
 *
 * So the issue paths and codes are folded into the message on the side that
 * still has them. Paths and codes are schema shape, not member data — the same
 * line `request_failed` already draws when it records `validation_issues` — so
 * they are safe to carry across. Values are not, and are left behind.
 *
 * The message stays within the character class `scheduledAlarmErrorCode`
 * requires, so an alarm failure reported this way reaches the operator notice
 * as a code rather than as `handler_error`.
 */
export function parseRpcInput<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
  schemaName: string,
): z.infer<Schema> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new Error(codeShaped(`${schemaName}_invalid:${describeIssues(result.error)}`).slice(0, 120));
}
