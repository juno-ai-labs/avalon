import { describe, expect, it } from "vitest";
import { z } from "zod/v3";
import { providerJsonSchema } from "./json-schema";
import { STRICT_UUID_JSON_SCHEMA_PATTERN, STRICT_UUID_PATTERN } from "./uuid-validation";

describe("providerJsonSchema", () => {
  it("preserves strict object fields, defaults, and refinements for provider input", () => {
    const schema = providerJsonSchema(z.object({
      query: z.string().min(1),
      limit: z.number().int().safe().positive().default(10),
    }).strict().superRefine(() => undefined));

    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1 },
        limit: {
          type: "integer",
          exclusiveMinimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
          minimum: Number.MIN_SAFE_INTEGER,
          default: 10,
        },
      },
      $schema: "https://json-schema.org/draft/2020-12/schema",
    });
    expect(schema.required).toEqual(["query", "limit"]);
  });

  it("restores UUID format metadata for the strict compatibility pattern", () => {
    expect(providerJsonSchema(z.string().regex(STRICT_UUID_PATTERN, "Invalid UUID"))).toMatchObject({
      type: "string",
      format: "uuid",
      pattern: STRICT_UUID_JSON_SCHEMA_PATTERN,
    });
  });

  it("restores compatibility metadata inside union branches", () => {
    const schema = providerJsonSchema(z.union([
      z.object({
        id: z.string().regex(STRICT_UUID_PATTERN, "Invalid UUID"),
        limit: z.number().int().safe().positive().default(10),
      }).strict(),
      z.object({ cursor: z.string() }).strict(),
    ]));

    expect(schema).toMatchObject({
      anyOf: [{
        properties: {
          id: { format: "uuid", pattern: STRICT_UUID_JSON_SCHEMA_PATTERN },
          limit: { default: 10 },
        },
        required: ["id", "limit"],
      }, { required: ["cursor"] }],
    });
  });
});
