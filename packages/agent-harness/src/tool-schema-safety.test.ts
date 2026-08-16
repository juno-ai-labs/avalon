import { describe, expect, it } from "vitest";

import { emptiedCompositionBranches } from "./tool-schema-safety";

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

describe("emptiedCompositionBranches", () => {
  it("catches a composition branch that is only a `required`", () => {
    expect(emptiedCompositionBranches(MEMORY_SEARCH_BEFORE_THE_FIX)).toEqual(["/oneOf/0", "/oneOf/1"]);
  });

  it("catches one emptied branch beside a surviving sibling", () => {
    expect(emptiedCompositionBranches({
      type: "object",
      properties: { cursor: { type: "string" }, limit: { type: "integer" } },
      anyOf: [
        { type: "object", properties: { limit: { type: "integer" } } },
        { required: ["cursor"] },
      ],
    })).toEqual(["/anyOf/1"]);
  });

  it("reaches a branch nested under a property, an array item, and a `not`", () => {
    expect(emptiedCompositionBranches({
      type: "object",
      properties: {
        filter: { type: "object", properties: { a: { type: "string" } }, oneOf: [{ required: ["a"] }] },
        rows: { type: "array", items: { type: "object", properties: { b: { type: "string" } }, anyOf: [{ required: ["b"] }] } },
      },
      not: { anyOf: [{ required: ["filter"] }] },
    })).toEqual(["/not/anyOf/0", "/properties/filter/oneOf/0", "/properties/rows/items/anyOf/0"]);
  });

  it("passes a composition whose branches carry their own properties", () => {
    // The idiom that survives sanitization, and what an exclusive choice should
    // look like when it has to be expressed structurally at all.
    expect(emptiedCompositionBranches({
      anyOf: [
        { type: "object", properties: { resourceId: { type: "string" } }, required: ["resourceId"] },
        { type: "object", properties: { cursor: { type: "string" } }, required: ["cursor"] },
      ],
    })).toEqual([]);
  });

  it("passes a plain object schema and an empty one", () => {
    expect(emptiedCompositionBranches({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    })).toEqual([]);
    expect(emptiedCompositionBranches({ type: "object", properties: {} })).toEqual([]);
  });

  it("does not read a parameter named `oneOf` as a composition", () => {
    // The walk descends into `properties` values as subschemas, so a tool that
    // takes an argument called `oneOf` is never mistaken for one.
    expect(emptiedCompositionBranches({
      type: "object",
      properties: { oneOf: { type: "array", items: { type: "string" } } },
      required: ["oneOf"],
    })).toEqual([]);
  });

  it("tolerates a non-object root rather than throwing", () => {
    expect(emptiedCompositionBranches({} as Record<string, unknown>)).toEqual([]);
  });
});
