import { describe, expect, it } from "vitest";
import { z } from "zod";
import { z as z3 } from "zod/v3";
import {
  formatToolArgumentValidationError,
  isZodValidationError,
  normalizeToolArguments,
  validateToolArguments,
} from "./tool-arguments";

describe("tool argument normalization", () => {
  it("normalizes schema-declared numeric strings through objects, arrays, and nullable types", () => {
    const schema = {
      type: "object",
      properties: {
        offset: { type: "integer" },
        ratio: { type: "number" },
        optionalCount: { type: ["integer", "null"] },
        rows: {
          type: "array",
          items: {
            type: "object",
            properties: { score: { type: "number" } },
          },
        },
      },
    };

    expect(normalizeToolArguments({
      offset: "0",
      ratio: "1.25",
      optionalCount: "6e2",
      rows: [{ score: "-3.5" }],
    }, schema)).toEqual({
      offset: 0,
      ratio: 1.25,
      optionalCount: 600,
      rows: [{ score: -3.5 }],
    });
  });

  it("selects the structurally matching union branch before normalizing", () => {
    const schema = {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            resourceId: { type: "string" },
            startCharacter: { type: "integer" },
          },
          required: ["resourceId"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: { cursor: { type: "string" } },
          required: ["cursor"],
        },
      ],
    };

    expect(normalizeToolArguments({ resourceId: "resource-1", startCharacter: "0" }, schema))
      .toEqual({ resourceId: "resource-1", startCharacter: 0 });
  });

  it("follows local references in recursive tool schemas", () => {
    const schema = {
      type: "object",
      properties: { filter: { $ref: "#/$defs/filterNode" } },
      $defs: {
        filterNode: {
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              properties: { value: { type: "number" } },
              required: ["value"],
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                all: { type: "array", items: { $ref: "#/$defs/filterNode" } },
              },
              required: ["all"],
            },
          ],
        },
      },
    };

    expect(normalizeToolArguments({ filter: { all: [{ value: "2.5" }] } }, schema))
      .toEqual({ filter: { all: [{ value: 2.5 }] } });
  });

  it("bounds work for recursively branching provider schemas", () => {
    const schema = {
      $ref: "#/$defs/node",
      $defs: {
        node: {
          allOf: [
            { $ref: "#/$defs/node" },
            { $ref: "#/$defs/node" },
          ],
        },
      },
    };

    expect(normalizeToolArguments("unchanged", schema)).toBe("unchanged");
  });

  it("uses number semantics when a type array redundantly includes integer", () => {
    expect(normalizeToolArguments({ value: "1.5" }, {
      type: "object",
      properties: { value: { type: ["integer", "number"] } },
    })).toEqual({ value: 1.5 });
  });

  it("preserves numeric-looking strings whenever the schema accepts strings", () => {
    expect(normalizeToolArguments({ id: "00123", cell: "42" }, {
      type: "object",
      properties: {
        id: { type: "string" },
        cell: { type: ["string", "number"] },
      },
    })).toEqual({ id: "00123", cell: "42" });
  });

  it("rejects lossy or non-JSON numeric spellings", () => {
    for (const value of [" 1", "1 ", "+1", "01", ".5", "0x10", "Infinity", "1px", "1e-400", "9007199254740992"]) {
      expect(normalizeToolArguments({ value }, {
        type: "object",
        properties: { value: { type: "number" } },
      })).toEqual({ value });
    }
  });

  it("validates normalized arguments against the provider-facing schema", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        offset: { type: "integer", minimum: 0 },
      },
      required: ["offset"],
    };

    expect(validateToolArguments({ offset: 0 }, schema)).toBeNull();
    expect(validateToolArguments({ offset: "0" }, schema)).toBeInstanceOf(z.ZodError);
    expect(validateToolArguments({ offset: -1 }, schema)).toBeInstanceOf(z.ZodError);
  });

  it("does not blame arguments when a hosted schema cannot be compiled locally", () => {
    expect(validateToolArguments({ offset: "invalid" }, {
      $ref: "https://provider.example/schemas/tool-input.json",
    })).toBeNull();
  });
});

describe("tool argument validation errors", () => {
  it("recognizes validation failures from both Worker schema runtimes", () => {
    const v4 = z.object({ count: z.number() }).safeParse({ count: "one" });
    const v3 = z3.object({ count: z3.number() }).safeParse({ count: "one" });

    expect(v4.success).toBe(false);
    expect(v3.success).toBe(false);
    if (v4.success || v3.success) return;
    expect(isZodValidationError(v4.error)).toBe(true);
    expect(isZodValidationError(v3.error)).toBe(true);
    expect(formatToolArgumentValidationError(v3.error)).toContain(
      "count: expected number, received string",
    );
  });

  it("collapses union noise to the actionable branch", () => {
    const schema = z.union([
      z.object({
        resourceId: z.string(),
        startCharacter: z.number().int().optional(),
      }).strict(),
      z.object({ cursor: z.string() }).strict(),
    ]);

    const result = schema.safeParse({ resourceId: "resource-1", startCharacter: "not-a-number" });
    expect(result.success).toBe(false);
    if (result.success) return;

    const message = formatToolArgumentValidationError(result.error);
    expect(message).toContain("startCharacter: expected number, received string");
    expect(message).not.toContain("invalid_union");
    expect(message).not.toContain("cursor");
    expect(message).not.toContain("unrecognized_keys");
  });
});
