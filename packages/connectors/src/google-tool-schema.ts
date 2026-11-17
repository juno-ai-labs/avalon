import { memoizedValue } from "@rally/contracts/deferred-zod-schema";
import { z } from "zod";

/**
 * Preserve strict Google inputs through Bind, while runtime validation enforces
 * exclusive target choices. Returns a memoized reader rather than the schema:
 * every Google tool definition is built at module scope, and converting each
 * one there put the whole family's JSON Schema work on the API Worker's
 * startup budget. Expose it through a `get inputSchema()` getter.
 */
export function googleToolInputSchema(schema: z.ZodType): () => Record<string, unknown> {
  return memoizedValue(() => z.toJSONSchema(schema, {
    io: "input",
    override: ({ jsonSchema }) => {
      // Bind drops boolean false for xAI, but preserves an object-valued
      // schema that matches no value. Optional fields stay optional.
      if (jsonSchema.type === "object" && jsonSchema.additionalProperties === false) jsonSchema.additionalProperties = { not: {} };
    },
  }));
}
