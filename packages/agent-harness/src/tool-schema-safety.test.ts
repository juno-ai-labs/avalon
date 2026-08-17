import { describe, expect, it } from "vitest";

import {
  nonObjectRootUnionBranches,
  readableRootUnionBranch,
  repairRootUnionForProviders,
  weakenedCompositionBranches,
} from "./tool-schema-safety";

/**
 * The production fingerprint, kept as a literal: this exact schema shipped in
 * `memory_search` and 400'd every x-ai request in the fleet for three days.
 *
 * Under `@juno-ai/bind` 13 the sanitizer repairs it — each branch comes back as
 * `{ type: "object", required: [...], properties: {…} }` — so the checks below
 * report nothing for it. That is the *dependency's* behaviour, not this
 * module's, which is why it is asserted here: a bind release that stopped
 * repairing would put the original defect back on the wire, and this file is
 * where that would surface.
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
  it("still catches a branch whose `required` names nothing in scope", () => {
    // The positive case that survives bind 13. The branch is NESTED, so the
    // root-union drop does not apply, and `ghost` resolves against neither the
    // branch nor its parent, so the sanitizer prunes it to `{}` — a constraint
    // the author wrote and the wire schema no longer carries.
    expect(weakenedCompositionBranches({
      type: "object",
      properties: {
        filter: {
          type: "object",
          properties: { a: { type: "string" } },
          oneOf: [{ required: ["a"] }, { required: ["ghost"] }],
        },
      },
    })).toEqual(["/properties/filter/oneOf/1 (required dropped)"]);
  });

  it("reaches every subschema position the walk claims to cover", () => {
    // Traversal coverage, held with unresolvable names because a resolvable one
    // now survives sanitization and would make this assert nothing. Each path
    // is a different position: a property, an array item, a `not`, and
    // `dependentSchemas` (the 2019-09 successor to `dependencies`).
    expect(weakenedCompositionBranches({
      type: "object",
      properties: {
        filter: { type: "object", properties: { a: { type: "string" } }, oneOf: [{ required: ["ghost"] }] },
        rows: { type: "array", items: { type: "object", properties: { b: { type: "string" } }, anyOf: [{ required: ["ghost"] }] } },
      },
      dependentSchemas: {
        filter: { type: "object", properties: { c: { type: "string" } }, oneOf: [{ required: ["ghost"] }] },
      },
      not: { anyOf: [{ required: ["ghost"] }] },
    })).toEqual([
      "/not/anyOf/0 (required dropped)",
      "/properties/filter/oneOf/0 (required dropped)",
      "/properties/rows/items/anyOf/0 (required dropped)",
      "/dependentSchemas/filter/oneOf/0 (required dropped)",
    ]);
  });

  it("reports nothing for the shapes the sanitizer repairs", () => {
    // Each of these was a finding under bind 11. The sanitizer now resolves a
    // branch's `required` against its parent's `properties` and copies the
    // referenced subschemas down, so the constraint reaches the wire intact and
    // there is nothing left to report. If any of these starts failing, the
    // dependency regressed rather than this module.
    expect(weakenedCompositionBranches(MEMORY_SEARCH_BEFORE_THE_FIX)).toEqual([]);
    // A bare `required` beside a sibling that already carries its own properties.
    expect(weakenedCompositionBranches({
      type: "object",
      properties: { cursor: { type: "string" }, limit: { type: "integer" } },
      anyOf: [
        { type: "object", properties: { limit: { type: "integer" } } },
        { required: ["cursor"] },
      ],
    })).toEqual([]);
    // The annotation form: `{ description, required }` used to prune to
    // `{ description }`, which is not empty and constrains exactly as little.
    expect(weakenedCompositionBranches({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      oneOf: [{ description: "choose a", required: ["a"] }, { description: "choose b", required: ["b"] }],
    })).toEqual([]);
    // The silent form: `{ type: "object", required }` used to prune to
    // `{ type: "object" }`, which xAI accepts, so no other check stood in front
    // of it.
    expect(weakenedCompositionBranches({
      type: "object",
      properties: { query: { type: "string" }, memoryItemId: { type: "string" } },
      oneOf: [{ type: "object", required: ["query"] }, { type: "object", required: ["memoryItemId"] }],
    })).toEqual([]);
  });

  it("passes a composition whose branches carry their own properties", () => {
    // The idiom that always survived sanitization, and what an exclusive choice
    // should look like when it has to be expressed structurally at all.
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
  it("reports nothing for a root branch carrying its own composition, which bind 13 now drops", () => {
    // This was the guard's last live finding. Bind 12 forwarded the shape
    // straight into a 400 on all three Grok models; bind 13 drops the
    // composition, so there is nothing left for the guard to report. Kept as a
    // regression test on the dependency — the rule it encodes is asserted
    // directly against `readableRootUnionBranch` below, where no sanitizer
    // version can hide it.
    expect(nonObjectRootUnionBranches({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      oneOf: [
        { type: "object", anyOf: [{ properties: { a: { type: "string" } } }, { properties: { b: { type: "string" } } }] },
        { type: "object", properties: { b: { type: "string" } } },
      ],
    })).toEqual([]);
  });

  it("reports nothing for the root unions the sanitizer repairs or drops", () => {
    // Repaired into object branches:
    expect(nonObjectRootUnionBranches(MEMORY_SEARCH_BEFORE_THE_FIX)).toEqual([]);
    // Dropped, because no branch can be made usable:
    expect(nonObjectRootUnionBranches({
      type: "object",
      properties: { query: { type: "string" } },
      oneOf: [{}, {}],
    })).toEqual([]);
    // Dropped: a declared non-object `type` disqualifies a branch whatever its
    // `properties` says.
    expect(nonObjectRootUnionBranches({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      oneOf: [
        { type: "string", properties: { a: { type: "string" } } },
        { type: "object", properties: { b: { type: "string" } } },
      ],
    })).toEqual([]);
    // Dropped: annotation-only branches assert nothing.
    expect(nonObjectRootUnionBranches({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      oneOf: [{ description: "choose a" }, { description: "choose b" }],
    })).toEqual([]);
  });

  it("passes a root union whose branches are recognizably objects", () => {
    expect(nonObjectRootUnionBranches({
      type: "object",
      properties: { query: { type: "string" }, memoryItemId: { type: "string" } },
      oneOf: [{ type: "object", required: ["query"] }, { type: "object", required: ["memoryItemId"] }],
    })).toEqual([]);
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
 *
 * These run on the authored schema without invoking the sanitizer, so they are
 * independent of the installed bind version — which makes this block the
 * standing coverage for the measured branch rules themselves, now that the
 * sanitizer repairs most of them before the guard above ever sees them.
 */
describe("repairRootUnionForProviders", () => {
  it("defers to the sanitizer when the sanitizer already handles the shape", () => {
    // Repairing this unconditionally is now WORSE than doing nothing. Bind 13
    // turns it into self-sufficient object branches that every provider accepts
    // and the model can actually read; dropping the composition first throws
    // that constraint away and tells the model nothing. Under bind 11 and 12
    // the drop was the only thing between a remote schema and a 400.
    const remote = {
      type: "object",
      properties: { pageId: { type: "string" }, discussionId: { type: "string" } },
      oneOf: [{ required: ["pageId"] }, { required: ["discussionId"] }],
    };

    expect(repairRootUnionForProviders(remote)).toBe(remote);
  });

  it("leaves the annotation-only and conflicting-`type` shapes to the sanitizer too", () => {
    const annotationOnly = {
      type: "object",
      properties: { a: { type: "string" } },
      anyOf: [{ description: "choose a" }, { description: "or not" }],
    };
    const conflictingType = {
      type: "object",
      properties: { a: { type: "string" } },
      oneOf: [{ type: "string", properties: { a: { type: "string" } } }],
    };

    expect(repairRootUnionForProviders(annotationOnly)).toBe(annotationOnly);
    expect(repairRootUnionForProviders(conflictingType)).toBe(conflictingType);
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

/**
 * The measured rules themselves, asserted against the predicate rather than
 * through whatever the installed sanitizer happens to do with them.
 *
 * This block exists because the checks above have gone quiet: bind 13 repairs
 * or drops every shape they were built to catch, so they now assert the
 * dependency's behaviour more than this module's. These clauses cost roughly
 * two hundred live provider requests to establish and are the durable part; a
 * sanitizer that changes underneath them must not be able to make them
 * vacuous.
 */
describe("readableRootUnionBranch", () => {
  it("accepts a branch that is recognizably an object", () => {
    expect(readableRootUnionBranch({ type: "object" })).toBe(true);
    expect(readableRootUnionBranch({ type: "object", required: ["a"] })).toBe(true);
    expect(readableRootUnionBranch({ properties: { a: { type: "string" } } })).toBe(true);
    expect(readableRootUnionBranch({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    })).toBe(true);
  });

  it("rejects a branch that asserts nothing", () => {
    expect(readableRootUnionBranch({})).toBe(false);
    expect(readableRootUnionBranch({ required: ["a"] })).toBe(false);
    expect(readableRootUnionBranch({ description: "choose a" })).toBe(false);
    expect(readableRootUnionBranch(null)).toBe(false);
    expect(readableRootUnionBranch("nope")).toBe(false);
  });

  it("lets a declared `type` decide by itself", () => {
    // `properties` does not rescue a branch whose own `type` contradicts it:
    // measured 0/3 on Grok, identical to a bare `{ type: "string" }`.
    expect(readableRootUnionBranch({ type: "string", properties: { a: { type: "string" } } })).toBe(false);
    expect(readableRootUnionBranch({ type: "array", properties: { a: { type: "string" } } })).toBe(false);
    expect(readableRootUnionBranch({ type: "string" })).toBe(false);
  });

  it("rejects a branch carrying its own composition, whatever its type", () => {
    // Measured 0/3 on Grok even with `type: "object"` present.
    expect(readableRootUnionBranch({ type: "object", anyOf: [{ type: "object" }] })).toBe(false);
    expect(readableRootUnionBranch({ type: "object", oneOf: [{ type: "object" }] })).toBe(false);
    expect(readableRootUnionBranch({ type: "object", allOf: [{ type: "object" }] })).toBe(false);
  });

  it("looks only at the branch's own keywords, never its subtree", () => {
    // A composition under one of the branch's PROPERTIES is accepted by all
    // nine models. Treating this as a subtree scan would discard legitimate
    // constraints to fix a problem that does not exist.
    expect(readableRootUnionBranch({
      type: "object",
      properties: { a: { anyOf: [{ type: "string" }, { type: "number" }] } },
      required: ["a"],
    })).toBe(true);
    expect(readableRootUnionBranch({
      type: "object",
      properties: { a: { type: "object", properties: { inner: { oneOf: [{ type: "string" }] } } } },
    })).toBe(true);
  });
});
