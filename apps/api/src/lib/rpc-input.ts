import { codeShaped, describeZodIssues } from "@rally/contracts/zod-diagnostics";
import type { z } from "zod";

/**
 * Parse one Durable Object RPC method's input so a rejection survives the hop.
 *
 * A `ZodError` does not cross an RPC boundary. The serializer reduces it to a
 * plain `Error` carrying no `issues`, no message and not even the name —
 * `structuredClone` of one keeps `stack` and nothing else — so the calling
 * object logs the bare word `ZodError` and stops. That names neither the field,
 * nor the schema, nor which of a handler's several parses failed.
 *
 * It cost a day in production: a Sidekick's `sidekick_publication` alarm threw
 * here on every attempt, so its external-event registrations were never written
 * and its trigger never fired, while the Sidekick showed as published.
 *
 * The description is `@rally/contracts`' to compose — the same one a connector
 * failure and an alarm notice use, because this was the third boundary to lose
 * the same information in the same week.
 */
export function parseRpcInput<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
  schemaName: string,
): z.infer<Schema> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  // `namesUnknownKeys` is admissible here and nowhere else so far: both sides
  // of a Durable Object RPC are this deployment's own code, so an unrecognized
  // key is a field one binary knows and the other does not — the whole
  // diagnosis of a version skew, and never a caller's data.
  throw new Error(codeShaped(`${schemaName}_invalid:${describeZodIssues(result.error, { namesUnknownKeys: true })}`));
}
