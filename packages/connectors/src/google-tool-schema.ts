import { z } from "zod";
import { memoizedValue } from "@rally/contracts/deferred-zod-schema";

/** Preserve strict Google inputs through Bind, while runtime validation enforces exclusive target choices. */
export function googleToolInputSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, {
    io: "input",
    override: ({ jsonSchema }) => {
      // Bind drops boolean false for xAI, but preserves an object-valued
      // schema that matches no value. Optional fields stay optional.
      if (jsonSchema.type === "object" && jsonSchema.additionalProperties === false) jsonSchema.additionalProperties = { not: {} };
    },
  });
  return json;
}

/**
 * `googleToolInputSchema`, converted on the first read of a tool's
 * `inputSchema` rather than while the module loads. The Google catalog is
 * statically reachable from every API Worker isolate, and converting its
 * schemas eagerly was the largest single named cost in the startup profile;
 * see docs/api-worker-deployment.md. Read it from a getter so the
 * `ToolDefinition` surface stays a plain object; `schema` is a thunk so a
 * module may name a schema it declares further down.
 */
export function deferredGoogleToolInputSchema(schema: () => z.ZodType): () => Record<string, unknown> {
  return memoizedValue(() => googleToolInputSchema(schema()));
}
