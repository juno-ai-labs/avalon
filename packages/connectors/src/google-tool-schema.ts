import { z } from "zod";

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
