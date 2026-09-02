import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  formatToolArgumentValidationError,
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

  it("drops a blanked optional field the schema says cannot be empty", () => {
    const schema = {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        after: { type: ["string", "null"], minLength: 1, maxLength: 500 },
        teamId: { type: ["string", "null"], minLength: 1 },
        first: { type: "integer", minimum: 1 },
        sort: { type: "string", enum: ["score", "recency"] },
      },
      required: ["query"],
    };

    expect(normalizeToolArguments({
      query: "flaky rebase test",
      after: "",
      teamId: "",
      first: "",
      sort: "",
    }, schema)).toEqual({ query: "flaky rebase test" });
  });

  it("keeps an empty string wherever it is a value the tool accepts", () => {
    const schema = {
      type: "object",
      properties: {
        // A cleared description and a repository root are both real requests.
        description: { type: ["string", "null"], maxLength: 40_000 },
        path: { type: "string", maxLength: 1_000 },
        label: { enum: ["", "draft"] },
        note: { description: "A schema this normalizer cannot read." },
      },
    };
    const input = { description: "", path: "", label: "", note: "" };

    expect(normalizeToolArguments(input, schema)).toBe(input);
  });

  it("keeps a blanked required field so validation names it", () => {
    const schema = {
      type: "object",
      properties: { query: { type: "string", minLength: 1 } },
      required: ["query"],
    };

    expect(normalizeToolArguments({ query: "" }, schema)).toEqual({ query: "" });
    const error = validateToolArguments({ query: "" }, schema);
    expect(error).not.toBeNull();
    expect(formatToolArgumentValidationError(error!)).toContain("query");
  });

  it("drops a blank only when every branch of a composed schema rejects it", () => {
    const rejecting = {
      type: "object",
      properties: {
        ref: { anyOf: [{ type: "string", minLength: 1 }, { type: "integer" }] },
      },
    };
    const accepting = {
      type: "object",
      properties: {
        ref: { anyOf: [{ type: "string", minLength: 1 }, { type: "string", maxLength: 10 }] },
      },
    };

    expect(normalizeToolArguments({ ref: "" }, rejecting)).toEqual({});
    expect(normalizeToolArguments({ ref: "" }, accepting)).toEqual({ ref: "" });
  });

  it("leaves an undeclared blank alone so a strict parse still reports it", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { query: { type: "string", minLength: 1 } },
    };

    expect(normalizeToolArguments({ query: "release notes", preview: "" }, schema))
      .toEqual({ query: "release notes", preview: "" });
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
