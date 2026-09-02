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
    }, schema, "read")).toEqual({ query: "flaky rebase test" });
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

    expect(normalizeToolArguments(input, schema, "read")).toBe(input);
  });

  it("keeps a blanked required field so validation names it", () => {
    const schema = {
      type: "object",
      properties: { query: { type: "string", minLength: 1 } },
      required: ["query"],
    };

    expect(normalizeToolArguments({ query: "" }, schema, "read")).toEqual({ query: "" });
    const error = validateToolArguments({ query: "" }, schema);
    expect(error).not.toBeNull();
    expect(formatToolArgumentValidationError(error!)).toContain("query");
  });

  it("keeps a blank on a write, where absence and null mean different things", () => {
    // On a read, absence is the only alternative to a value. On a write it is
    // not: clearing a field and leaving it alone are different requests, so
    // reading `""` as either one picks an intent the model never stated. The
    // executor rejects it by name instead, which is one correction away from
    // the `null` that actually clears.
    const schema = {
      type: "object",
      properties: {
        issueId: { type: "string", minLength: 1 },
        priority: { type: ["integer", "null"], minimum: 0 },
        assigneeId: { type: ["string", "null"], minLength: 1 },
      },
      required: ["issueId"],
    };
    const input = { issueId: "i1", priority: 3, assigneeId: "" };

    expect(normalizeToolArguments(input, schema, "write")).toEqual(input);
    expect(normalizeToolArguments(input, schema, "read"))
      .toEqual({ issueId: "i1", priority: 3 });
  });

  it("defaults to the write behavior when no mode is given", () => {
    const schema = { type: "object", properties: { after: { type: "string", minLength: 1 } } };

    expect(normalizeToolArguments({ after: "" }, schema)).toEqual({ after: "" });
  });

  it("keeps a blank required by a schema composed into the one declaring it", () => {
    // `required` and `properties` need not sit on the same node. Reading only
    // the node that carries `properties` deleted the field a sibling branch
    // required, and a hosted MCP tool then ran with the argument missing
    // instead of being told the value was invalid.
    const viaAllOf = {
      type: "object",
      properties: { target: { type: "string", minLength: 1 } },
      allOf: [{ required: ["target"] }],
    };
    const viaRef = {
      type: "object",
      $defs: { identity: { required: ["target"] } },
      properties: { target: { type: "string", minLength: 1 } },
      $ref: "#/$defs/identity",
    };
    const viaBranch = {
      type: "object",
      properties: { target: { type: "string", minLength: 1 }, all: { type: "boolean" } },
      anyOf: [{ required: ["target"] }, { required: ["all"] }],
    };

    expect(normalizeToolArguments({ target: "" }, viaAllOf, "read")).toEqual({ target: "" });
    expect(normalizeToolArguments({ target: "" }, viaRef, "read")).toEqual({ target: "" });
    expect(normalizeToolArguments({ target: "" }, viaBranch, "read")).toEqual({ target: "" });
  });

  it("keeps a blank a conditional keyword could require", () => {
    // `dependentRequired` and `if`/`then` answer "is this required" only
    // against the instance being validated. This walk does not evaluate them,
    // so a schema carrying one is unproven rather than unrequiring.
    const dependent = {
      type: "object",
      properties: { other: { type: "string" }, target: { type: "string", minLength: 1 } },
      dependentRequired: { other: ["target"] },
    };
    const conditional = {
      type: "object",
      properties: { kind: { type: "string" }, target: { type: "string", minLength: 1 } },
      if: { properties: { kind: { const: "byId" } } },
      then: { required: ["target"] },
    };

    expect(normalizeToolArguments({ other: "x", target: "" }, dependent, "read"))
      .toEqual({ other: "x", target: "" });
    expect(normalizeToolArguments({ kind: "byId", target: "" }, conditional, "read"))
      .toEqual({ kind: "byId", target: "" });
  });

  it("keeps a blank the depth bound stopped it from reading", () => {
    let deep: Record<string, unknown> = { required: ["target"] };
    for (let index = 0; index < 70; index += 1) deep = { allOf: [deep] };
    const schema = {
      type: "object",
      properties: { target: { type: "string", minLength: 1 } },
      ...deep,
    };

    expect(normalizeToolArguments({ target: "" }, schema, "read")).toEqual({ target: "" });
  });

  it("strips nothing inside a nested value, where requiredness is not resolvable", () => {
    // An ancestor's composition branches can describe the same nested object
    // separately — one carrying `properties`, another `required` — and merging
    // them is a schema evaluator's job. The tool's own arguments object is the
    // one place this walk can answer the question, so it is the only place it
    // answers it.
    const schema = {
      type: "object",
      allOf: [
        { properties: { target: { type: "object", properties: { id: { type: "string", minLength: 1 } } } } },
        { properties: { target: { type: "object", required: ["id"] } } },
      ],
    };

    expect(normalizeToolArguments({ target: { id: "" } }, schema, "read"))
      .toEqual({ target: { id: "" } });
  });

  it("keeps every blank when it cannot finish reading what the schema requires", () => {
    const unresolvable = {
      type: "object",
      properties: { target: { type: "string", minLength: 1 } },
      $ref: "#/$defs/missing",
    };

    expect(normalizeToolArguments({ target: "" }, unresolvable, "read")).toEqual({ target: "" });
  });

  it("still drops a blank the composition leaves optional", () => {
    const schema = {
      type: "object",
      properties: {
        target: { type: "string", minLength: 1 },
        after: { type: ["string", "null"], minLength: 1 },
      },
      allOf: [{ required: ["target"] }],
    };

    expect(normalizeToolArguments({ target: "issue-1", after: "" }, schema, "read"))
      .toEqual({ target: "issue-1" });
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

    expect(normalizeToolArguments({ ref: "" }, rejecting, "read")).toEqual({});
    expect(normalizeToolArguments({ ref: "" }, accepting, "read")).toEqual({ ref: "" });
  });

  it("leaves an undeclared blank alone so a strict parse still reports it", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { query: { type: "string", minLength: 1 } },
    };

    expect(normalizeToolArguments({ query: "release notes", preview: "" }, schema, "read"))
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
