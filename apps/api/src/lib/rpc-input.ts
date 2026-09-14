import type { z } from "zod";

/**
 * How many issues a rejection names before it stops.
 *
 * The first few locate the defect; a projection with thirty bad evaluators is
 * one bug, and listing all thirty only pushes the message past the length at
 * which it still reads as a code.
 */
const REPORTED_ISSUES = 3;

/** Issue paths and codes, reduced to something that stays code-shaped. */
function describeIssues(error: z.ZodError): string {
  const described = error.issues.slice(0, REPORTED_ISSUES).map((issue) => {
    // `:` separates the fields of one issue and joins them, so a path segment
    // carrying one would read as an extra field. Segments are object keys and
    // array indices, which never legitimately contain one.
    const path = issue.path.length === 0 ? "(root)" : issue.path.join(".").replace(/[^A-Za-z0-9_.-]/gu, "_");
    return `${path}:${issue.code}`;
  });
  return described.join(":") || "(no_issues)";
}

/**
 * Parse one Durable Object RPC method's input so a rejection survives the hop.
 *
 * A `ZodError` does not cross an RPC boundary. The serializer reduces it to a
 * plain `Error` carrying no `issues`, no message and not even the name —
 * `structuredClone` of one keeps `stack` and nothing else — so the calling
 * object logs the five letters `ZodError` and stops. That named neither the
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
  throw new Error(`${schemaName}_invalid:${describeIssues(result.error)}`.slice(0, 120));
}
