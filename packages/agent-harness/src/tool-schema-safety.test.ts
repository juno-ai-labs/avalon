import { describe, expect, it } from "vitest";

import {
  nonObjectRootUnionBranches,
  repairRootUnionForProviders,
  weakenedCompositionBranches,
} from "./tool-schema-safety";

/**
 * The production fingerprint, kept as a literal: this exact schema shipped in
 * `memory_search` and 400'd every x-ai request in the fleet for three days.
 */
const MEMORY_SEARCH_BEFORE_THE_FIX = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: { type: "string", minLength: 1, maxLength: 2_000 },
    memoryItemId: { type: "string", format: "uuid" },
  },
  oneOf: [{ required: ["query"] }, { required: ["memoryItemId"] }],
};

describe("weakenedCompositionBranches", () => {
  it("catches a composition branch that is only a `required`", () => {
    expect(weakenedCompositionBranches(MEMORY_SEARCH_BEFORE_THE_FIX))
      .toEqual(["/oneOf/0 (required dropped)", "/oneOf/1 (required dropped)"]);
  });

  it("catches one weakened branch beside a surviving sibling", () => {
    expect(weakenedCompositionBranches({
      type: "object",
      properties: { cursor: { type: "string" }, limit: { type: "integer" } },
      anyOf: [
        { type: "object", properties: { limit: { type: "integer" } } },
        { required: ["cursor"] },
      ],
    })).toEqual(["/anyOf/1 (required dropped)"]);
  });

  it("catches a branch whose annotation survives the pruning", () => {
    // The literal-empty test is not enough: sanitizing
    // `{ description, required }` leaves `{ description }`, which is not empty
    // and constrains exactly as little as `{}` does.
    expect(weakenedCompositionBranches({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      oneOf: [{ description: "choose a", required: ["a"] }, { description: "choose b", required: ["b"] }],
    })).toEqual(["/oneOf/0 (required dropped)", "/oneOf/1 (required dropped)"]);
  });

  it("catches a branch that keeps its `type` but loses its `required`", () => {
    // `{ type: "object", required: [...] }` sanitizes to `{ type: "object" }`.
    // `nonObjectRootUnionBranches` deliberately passes that shape — xAI accepts
    // it — so this check is the only thing standing between it and a silently
    // discarded constraint.
    expect(weakenedCompositionBranches({
      type: "object",
      properties: { query: { type: "string" }, memoryItemId: { type: "string" } },
      oneOf: [{ type: "object", required: ["query"] }, { type: "object", required: ["memoryItemId"] }],
    })).toEqual(["/oneOf/0 (required dropped)", "/oneOf/1 (required dropped)"]);
  });

  it("reaches a branch nested under a property, an array item, a `not`, and `dependentSchemas`", () => {
    expect(weakenedCompositionBranches({
      type: "object",
      properties: {
        filter: { type: "object", properties: { a: { type: "string" } }, oneOf: [{ required: ["a"] }] },
        rows: { type: "array", items: { type: "object", properties: { b: { type: "string" } }, anyOf: [{ required: ["b"] }] } },
      },
      dependentSchemas: {
        filter: { type: "object", properties: { c: { type: "string" } }, oneOf: [{ required: ["c"] }] },
      },
      not: { anyOf: [{ required: ["filter"] }] },
    })).toEqual([
      "/not/anyOf/0 (required dropped)",
      "/properties/filter/oneOf/0 (required dropped)",
      "/properties/rows/items/anyOf/0 (required dropped)",
      "/dependentSchemas/filter/oneOf/0 (required dropped)",
    ]);
  });

  it("passes a composition whose branches carry their own properties", () => {
    // The idiom that survives sanitization, and what an exclusive choice should
    // look like when it has to be expressed structurally at all.
    expect(weakenedCompositionBranches({
      anyOf: [
        { type: "object", properties: { resourceId: { type: "string" } }, required: ["resourceId"] },
        { type: "object", properties: { cursor: { type: "string" } }, required: ["cursor"] },
      ],
    })).toEqual([]);
  });

  it("passes a plain object schema and an empty one", () => {
    expect(weakenedCompositionBranches({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    })).toEqual([]);
    expect(weakenedCompositionBranches({ type: "object", properties: {} })).toEqual([]);
  });

  it("does not read a parameter named `oneOf` as a composition", () => {
    // The walk descends into `properties` values as subschemas, so a tool that
    // takes an argument called `oneOf` is never mistaken for one.
    expect(weakenedCompositionBranches({
      type: "object",
      properties: { oneOf: { type: "array", items: { type: "string" } } },
      required: ["oneOf"],
    })).toEqual([]);
  });

  it("tolerates a non-object root rather than throwing", () => {
    expect(weakenedCompositionBranches({} as Record<string, unknown>)).toEqual([]);
  });
});

/**
 * Each expectation below was measured against grok-4.3/4.5/4.6, gemini-3.5/3.6/
 * 3.7-flash, and gpt-5.6-terra/sol/luna through OpenRouter, not inferred.
 */
describe("nonObjectRootUnionBranches", () => {
  it("catches the branch shape Grok rejects, authored or sanitized", () => {
    // Both forms 400 on all three Grok models; the sanitizer is not what makes
    // the authored one fatal, so restoring the `required` would not have helped.
    expect(nonObjectRootUnionBranches(MEMORY_SEARCH_BEFORE_THE_FIX)).toEqual(["/oneOf/0", "/oneOf/1"]);
    expect(nonObjectRootUnionBranches({
      type: "object",
      properties: { query: { type: "string" } },
      oneOf: [{}, {}],
    })).toEqual(["/oneOf/0", "/oneOf/1"]);
  });

  it("passes a root union whose branches are recognizably objects", () => {
    // `type: "object"` alone is enough — even with the `required` pruned away,
    // which is what the sanitizer does to a branch declaring no properties.
    expect(nonObjectRootUnionBranches({
      type: "object",
      properties: { query: { type: "string" }, memoryItemId: { type: "string" } },
      oneOf: [{ type: "object", required: ["query"] }, { type: "object", required: ["memoryItemId"] }],
    })).toEqual([]);
    // `properties` alone is enough too, and this is the shape to reach for: it
    // is the only one that ALSO survives sanitization with its `required`.
    expect(nonObjectRootUnionBranches({
      anyOf: [
        { type: "object", properties: { resourceId: { type: "string" } }, required: ["resourceId"] },
        { type: "object", properties: { cursor: { type: "string" } }, required: ["cursor"] },
      ],
    })).toEqual([]);
  });

  it("ignores a root `allOf`, which is an intersection every model accepts", () => {
    // Measured: a root `allOf` of constraint-only branches, and one Bind's
    // flatten cannot merge, are both accepted by all nine models including
    // every Grok. Reading it as a union would fail a schema nothing objects to.
    expect(nonObjectRootUnionBranches({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      allOf: [{ required: ["a"] }, { not: { required: ["b"] } }],
    })).toEqual([]);
  });

  it("catches an annotation-only root branch, which Grok also rejects", () => {
    expect(nonObjectRootUnionBranches({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      oneOf: [{ description: "choose a" }, { description: "choose b" }],
    })).toEqual(["/oneOf/0", "/oneOf/1"]);
  });

  it("ignores a nested union, which every model accepts", () => {
    expect(nonObjectRootUnionBranches({
      type: "object",
      properties: {
        filter: {
          type: "object",
          properties: { a: { type: "string" }, b: { type: "string" } },
          oneOf: [{ required: ["a"] }, { required: ["b"] }],
        },
      },
    })).toEqual([]);
  });

  it("passes a plain object schema with no root union at all", () => {
    expect(nonObjectRootUnionBranches({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    })).toEqual([]);
  });
});

/**
 * The repair a schema Avalon did not write goes through. A hosted MCP server's
 * `inputSchema` reaches the model verbatim and no build-time check can see it,
 * so the rule the guard reports on is applied here as a rewrite instead.
 */
describe("repairRootUnionForProviders", () => {
  it("drops a root union Grok would reject, keeping the rest of the schema", () => {
    const repaired = repairRootUnionForProviders({
      type: "object",
      properties: { query: { type: "string" }, memoryItemId: { type: "string" } },
      required: ["query"],
      oneOf: [{ required: ["query"] }, { required: ["memoryItemId"] }],
    });

    expect(repaired).toEqual({
      type: "object",
      properties: { query: { type: "string" }, memoryItemId: { type: "string" } },
      required: ["query"],
    });
    expect(nonObjectRootUnionBranches(repaired)).toEqual([]);
  });

  it("drops an annotation-only root union, which Grok rejects the same way", () => {
    expect(repairRootUnionForProviders({
      type: "object",
      properties: { a: { type: "string" } },
      anyOf: [{ description: "choose a" }, { description: "or not" }],
    })).toEqual({ type: "object", properties: { a: { type: "string" } } });
  });

  it("leaves a root union whose branches are already objects untouched", () => {
    // Repairing this would throw away a constraint every provider honours.
    const schema = {
      anyOf: [
        { type: "object", properties: { resourceId: { type: "string" } }, required: ["resourceId"] },
        { type: "object", properties: { cursor: { type: "string" } }, required: ["cursor"] },
      ],
    };

    expect(repairRootUnionForProviders(schema)).toBe(schema);
  });

  it("leaves a root `allOf` and a nested union untouched", () => {
    // Both are accepted by all nine models measured; rewriting either would
    // discard a constraint to fix a problem that does not exist.
    const allOf = {
      type: "object",
      properties: { a: { type: "string" } },
      allOf: [{ required: ["a"] }],
    };
    const nested = {
      type: "object",
      properties: { filter: { type: "object", oneOf: [{ required: ["a"] }] } },
    };

    expect(repairRootUnionForProviders(allOf)).toBe(allOf);
    expect(repairRootUnionForProviders(nested)).toBe(nested);
  });

  it("does not mutate the schema it was given", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" } },
      oneOf: [{ required: ["a"] }],
    };

    repairRootUnionForProviders(schema);

    expect(schema.oneOf).toEqual([{ required: ["a"] }]);
  });
});
