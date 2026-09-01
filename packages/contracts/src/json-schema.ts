import { zodToJsonSchema } from "zod-to-json-schema";
import type { z } from "zod/v3";
import { STRICT_UUID_PATTERN } from "./uuid-validation";

/** Convert a startup-efficient Zod v3 schema into the provider-facing contract. */
export function providerJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const converted = zodToJsonSchema(schema, {
    $refStrategy: "none",
    effectStrategy: "input",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  // Zod v4's output-schema conversion marks defaulted fields as required: the
  // parser always supplies them. Preserve that provider contract while the v3
  // converter describes the parser's accepted input by default.
  requireDefaultedProperties(converted);
  restoreUuidFormats(converted);
  converted.$schema = "https://json-schema.org/draft/2020-12/schema";
  return converted;
}

function restoreUuidFormats(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const schema = value as Record<string, unknown>;
  if (schema.pattern === STRICT_UUID_PATTERN.source) {
    delete schema.pattern;
    schema.format = "uuid";
  }
  for (const nested of Object.values(schema)) restoreUuidFormats(nested);
}

function requireDefaultedProperties(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const schema = value as Record<string, unknown>;
  if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
    const properties = schema.properties as Record<string, unknown>;
    const required = new Set(Array.isArray(schema.required)
      ? schema.required.filter((field): field is string => typeof field === "string")
      : []);
    for (const [field, property] of Object.entries(properties)) {
      if (property && typeof property === "object" && !Array.isArray(property) && "default" in property) {
        required.add(field);
      }
    }
    if (required.size > 0) schema.required = [...required];
  }
  for (const nested of Object.values(schema)) requireDefaultedProperties(nested);
}
