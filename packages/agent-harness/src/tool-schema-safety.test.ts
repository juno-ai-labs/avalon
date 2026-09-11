import { describe, expect, it } from "vitest";

import { sanitizeToolSchema } from "@juno-ai/bind/tools";

import {
  droppedNullableBranches,
  nonObjectRootUnionBranches,
  readableRootUnionBranch,
  repairRootSchemaForProviders,
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

  it("catches a root composition the sanitizer removes outright", () => {
    // Bind 13 deletes a root union no branch of which can be made usable. That
    // is provider-safe and deliberate, and it is still an authored constraint
    // that never reached the wire — and it is invisible to
    // `nonObjectRootUnionBranches`, which has nothing left to judge once the
    // union is gone. An earlier version of this walk stopped at the missing
    // array and reported nothing, so a first-party tool could have lost a whole
    // union with both checks green.
    expect(weakenedCompositionBranches({
      type: "object",
      properties: { a: { type: "string" } },
      oneOf: [{ required: ["ghost"] }],
    })).toEqual(["/oneOf (composition dropped)"]);
  });

  it("catches a root union dropped because a branch carried its own union", () => {
    expect(weakenedCompositionBranches({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      oneOf: [
        { type: "object", anyOf: [{ properties: { a: { type: "string" } } }] },
        { type: "object", properties: { b: { type: "string" } } },
      ],
    })).toEqual(["/oneOf (composition dropped)"]);
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
 * These are **not** version-independent, despite operating on authored input:
 * the gate calls `nonObjectRootUnionBranches`, which runs the sanitizer. Under
 * bind 13 every shape here is handled upstream, so the gate passes the schema
 * through untouched and `toBe` holds on identity. A bind release that stops
 * handling one of them flips that to a repair and fails this block — which is
 * the regression signal the gate exists to send, not a defect in this module.
 * The version-independent coverage of the rules themselves is the
 * `readableRootUnionBranch` block below.
 */
describe("repairRootSchemaForProviders", () => {
  it("merges a root union into one object instead of deleting it", () => {
    // The shape `z.union` emits, and the one that took `workstream_list_resources`
    // down: the root is *only* the union, so the previous drop-the-keyword
    // repair left `{}` — a tool advertising no parameters at all, whose
    // executor still requires them. Every property has to survive.
    const schema = {
      anyOf: [
        { type: "object", properties: { resourceId: { type: "string" } }, required: ["resourceId"] },
        { type: "object", properties: { cursor: { type: "string" } }, required: ["cursor"] },
      ],
    };

    expect(repairRootSchemaForProviders(schema)).toEqual({
      type: "object",
      properties: { resourceId: { type: "string" }, cursor: { type: "string" } },
    });
  });

  it("keeps every variant of a property the branches declare differently", () => {
    // A discriminated union is the commonest root union a hosted MCP server
    // serves, and the one first-declaration-wins gets silently wrong: it would
    // advertise `action` as `const: "create"` and delete the `delete` branch,
    // telling the model an action it supports is invalid. The union moves under
    // the property, where every provider measured accepts one.
    const schema = {
      anyOf: [
        { type: "object", properties: { action: { const: "create" }, name: { type: "string" } }, required: ["action", "name"] },
        { type: "object", properties: { action: { const: "delete" }, id: { type: "string" } }, required: ["action", "id"] },
      ],
    };

    expect(repairRootSchemaForProviders(schema)).toEqual({
      type: "object",
      properties: {
        action: { anyOf: [{ const: "create" }, { const: "delete" }] },
        name: { type: "string" },
        id: { type: "string" },
      },
      required: ["action"],
    });
  });

  it("does not turn a property every branch declares identically into a union", () => {
    // Key order carries no meaning in JSON Schema, so the two declarations here
    // are the same constraint. Emitting `anyOf` of a schema with itself would
    // be noise the model has to read on every call.
    const schema = {
      anyOf: [
        { type: "object", properties: { workspaceId: { type: "string", format: "uuid" } } },
        { type: "object", properties: { workspaceId: { format: "uuid", type: "string" } } },
      ],
    };

    expect(repairRootSchemaForProviders(schema)).toEqual({
      type: "object",
      properties: { workspaceId: { type: "string", format: "uuid" } },
    });
  });

  it("strips a root `enum` or `const` without reading its values as branches", () => {
    // `enum` always holds instance values and `const` may hold an array of
    // them, so neither is a list of subschemas. Walking them reads the object
    // value `{ properties: { mode: "fast" } }` as a branch declaring a property
    // `mode` whose schema is the string `"fast"` — not a schema at all, and a
    // shape a provider can reject on its own. They are removed, never merged.
    const enumSchema = {
      type: "object",
      properties: { a: { type: "string" } },
      enum: [{ properties: { mode: "fast" } }],
    };
    const constSchema = {
      type: "object",
      properties: { a: { type: "string" } },
      const: [{ properties: { mode: "slow" } }],
    };

    expect(repairRootSchemaForProviders(enumSchema)).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
    });
    expect(repairRootSchemaForProviders(constSchema)).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
    });
  });

  it("does not intersect sibling union keywords against each other", () => {
    // `anyOf` and `oneOf` at the same root are conjunctive: both must be
    // satisfied. Intersecting within each keyword and unioning across them
    // keeps `a` and `b`, which the schema genuinely requires. One accumulator
    // shared by both would intersect `a` against `b` and emit neither,
    // weakening a valid third-party schema into one the provider can satisfy
    // with arguments the remote tool then rejects.
    const schema = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      anyOf: [{ required: ["a"] }, { required: ["a"] }],
      oneOf: [{ required: ["b"] }, { required: ["b"] }],
    };

    expect(repairRootSchemaForProviders(schema)).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a", "b"],
    });
  });

  it("recombines a colliding property as an intersection when its branches were one", () => {
    // An `allOf` means every branch applies at once, so two declarations of the
    // same name are constraints that must both hold. Recombining them as
    // `anyOf` would say either will do and drop the other — the same silent
    // widening in the opposite direction from the union case above.
    const schema = {
      type: "object",
      allOf: [
        { properties: { size: { type: "integer", minimum: 1 } } },
        { properties: { size: { type: "integer", maximum: 10 } } },
      ],
    };

    expect(repairRootSchemaForProviders(schema)).toEqual({
      type: "object",
      properties: {
        size: { allOf: [{ type: "integer", minimum: 1 }, { type: "integer", maximum: 10 }] },
      },
    });
  });

  it("carries a branch's `$defs` up so a hoisted `$ref` still resolves", () => {
    // The merge lifts the branch's `properties` to the root and deletes the
    // branch. A `$ref` into that branch's own `$defs` would then point at a
    // subtree that no longer exists, and an unresolvable `$ref` is the same
    // class of rejection this corrector exists to prevent — it would have
    // manufactured the failure it is there to stop.
    const schema = {
      anyOf: [{
        type: "object",
        $defs: { Foo: { type: "string" } },
        properties: { a: { $ref: "#/$defs/Foo" } },
        required: ["a"],
      }],
    };

    expect(repairRootSchemaForProviders(schema)).toEqual({
      type: "object",
      $defs: { Foo: { type: "string" } },
      properties: { a: { $ref: "#/$defs/Foo" } },
      required: ["a"],
    });
  });

  it("keeps `additionalProperties` only when every branch agreed on it", () => {
    // `z.union` of strict objects emits `additionalProperties: false` per
    // branch. Dropping it advertises an open object while the executor still
    // parses strictly, which is checklist item 2 running backwards. Keeping one
    // branch's `false` over another's silence would instead forbid members the
    // merged object now legitimately admits.
    const agreed = {
      anyOf: [
        { type: "object", properties: { a: { type: "string" } }, additionalProperties: false },
        { type: "object", properties: { b: { type: "string" } }, additionalProperties: false },
      ],
    };
    const disagreed = {
      anyOf: [
        { type: "object", properties: { a: { type: "string" } }, additionalProperties: false },
        { type: "object", properties: { b: { type: "string" } } },
      ],
    };

    expect(repairRootSchemaForProviders(agreed)).toMatchObject({ additionalProperties: false });
    expect(repairRootSchemaForProviders(disagreed)).not.toHaveProperty("additionalProperties");
  });

  it("keeps only what every branch of a union requires", () => {
    // `required` is what a merge most easily gets backwards. The branches are
    // alternatives, so their union of `required` would demand both names at
    // once and make the tool uncallable; only a name every branch demands
    // survives, and `workspaceId` is the one both do.
    const schema = {
      anyOf: [
        { type: "object", properties: { workspaceId: { type: "string" }, pageId: { type: "string" } }, required: ["workspaceId", "pageId"] },
        { type: "object", properties: { workspaceId: { type: "string" }, discussionId: { type: "string" } }, required: ["workspaceId", "discussionId"] },
      ],
    };

    expect(repairRootSchemaForProviders(schema)).toEqual({
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        pageId: { type: "string" },
        discussionId: { type: "string" },
      },
      required: ["workspaceId"],
    });
  });

  it("repairs a root union the sanitizer is happy to leave, because Azure is not", () => {
    // This is the case the rule changed on. Bind 13 turns it into
    // self-sufficient object branches that xAI reads, so the previous gate
    // passed it through by identity — and Azure OpenAI still answers
    // `invalid_function_parameters` for the root `oneOf` alone. The exclusivity
    // is lost here knowingly; a constraint one provider can read is worth less
    // than a request the other does not reject outright.
    const remote = {
      type: "object",
      properties: { pageId: { type: "string" }, discussionId: { type: "string" } },
      oneOf: [{ required: ["pageId"] }, { required: ["discussionId"] }],
    };

    expect(repairRootSchemaForProviders(remote)).toEqual({
      type: "object",
      properties: { pageId: { type: "string" }, discussionId: { type: "string" } },
    });
  });

  it("unions what a root `allOf` requires rather than intersecting it", () => {
    // An intersection means every branch applies at once, so the opposite rule
    // to a union's. Azure rejects a root `allOf` as readily as a root `anyOf`,
    // so it is merged rather than left alone as the xAI-only rule allowed.
    const schema = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      allOf: [{ required: ["a"] }, { required: ["b"] }],
    };

    expect(repairRootSchemaForProviders(schema)).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a", "b"],
    });
  });

  it("gives a root that declares no type one, and keeps the rest of the schema", () => {
    const schema = {
      description: "kept",
      properties: { a: { type: "string" } },
      required: ["a"],
    };

    expect(repairRootSchemaForProviders(schema)).toEqual({
      type: "object",
      description: "kept",
      properties: { a: { type: "string" } },
      required: ["a"],
    });
  });

  it("drops a `required` naming a property the merge could not produce", () => {
    // A branch may require a name whose subschema lived somewhere the merge
    // cannot read. A `required` pointing at a property that is not there is
    // exactly what Bind's sanitizer prunes, so it must not be emitted.
    const schema = {
      anyOf: [{ type: "object", required: ["ghost"] }],
    };

    expect(repairRootSchemaForProviders(schema)).toEqual({ type: "object", properties: {} });
  });

  it("leaves a schema that is already a plain object untouched", () => {
    const schema = {
      type: "object",
      properties: { filter: { type: "object", oneOf: [{ required: ["a"] }] } },
      required: ["filter"],
    };

    expect(repairRootSchemaForProviders(schema)).toBe(schema);
  });

  it("does not mutate the schema it was given", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" } },
      oneOf: [{ required: ["a"] }],
    };

    repairRootSchemaForProviders(schema);

    expect(schema.oneOf).toEqual([{ required: ["a"] }]);
    expect(schema.properties).toEqual({ a: { type: "string" } });
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

  it("rejects a branch carrying its own union, whatever its type", () => {
    // Measured 0/3 on Grok even with `type: "object"` present.
    expect(readableRootUnionBranch({ type: "object", anyOf: [{ type: "object" }] })).toBe(false);
    expect(readableRootUnionBranch({ type: "object", oneOf: [{ type: "object" }] })).toBe(false);
  });

  it("accepts a branch carrying its own `allOf`, which is an intersection", () => {
    // Measured 9/9, Grok included — and Bind 13 deliberately keeps it. Rejecting
    // it would make the repair delete a root union the sanitizer preserved,
    // which is the same class of harm as the repair this PR just gated.
    expect(readableRootUnionBranch({ type: "object", allOf: [{ properties: { a: { type: "string" } } }] })).toBe(true);
    expect(readableRootUnionBranch({
      type: "object",
      properties: { a: { type: "string" } },
      allOf: [{ required: ["a"] }],
    })).toBe(true);
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

/**
 * The shape that had a scheduled Sidekick replying to itself, kept as a
 * literal: `slack_send_message.thread_ts` as authored, a flat nullable string
 * with a floor and a description that says to omit it or send `null`.
 *
 * Under `@juno-ai/bind` 13 the sanitizer collapsed it to `{ type: "string",
 * minLength: 1 }` with "Accepts string or null." appended to the description,
 * and a model that will not leave the key out put `"/"`, `". "` and
 * `".000001"` in it for thousands of refused calls, or the timestamp of its own
 * previous post. Bind 14 rewrites it to a union instead. That is the
 * dependency's behaviour, not this module's, which is why it is asserted here:
 * a bind release that collapsed again would put the invented values back, and
 * this file is where that would surface first.
 */
const SEND_MESSAGE_THREAD_TS_AS_AUTHORED = {
  type: "object",
  additionalProperties: false,
  properties: {
    channel_id: { type: "string", minLength: 1, description: "Where to post the message." },
    text: { type: "string", minLength: 1, maxLength: 40_000, description: "The message body." },
    thread_ts: {
      type: ["string", "null"],
      minLength: 1,
      description: "Post as a reply inside an existing thread. Omit it, or send `null`, to post a new top-level message.",
    },
  },
  required: ["channel_id", "text"],
};

describe("droppedNullableBranches", () => {
  it("reports nothing for a flat nullable string, which bind 14 delivers as a union", () => {
    expect(droppedNullableBranches(SEND_MESSAGE_THREAD_TS_AS_AUTHORED)).toEqual([]);
    // The wire shape itself, so the assertion above cannot pass by the guard
    // going quiet: the null branch is a value the model can send, and the
    // description no longer carries the "Accepts string or null." note that
    // stood in for it.
    const wire = sanitizeToolSchema(SEND_MESSAGE_THREAD_TS_AS_AUTHORED) as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(wire.properties.thread_ts).toEqual({
      anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
      description: "Post as a reply inside an existing thread. Omit it, or send `null`, to post a new top-level message.",
    });
  });

  it("still reports a multi-type union, which bind 14 collapses as before", () => {
    // Case (b) of bind's transform #1: no single shape every provider accepts,
    // so `["string", "number", "null"]` becomes `"string"` with the rest in
    // prose, and the authored null is gone from the wire.
    expect(droppedNullableBranches({
      type: "object",
      properties: {
        value: { type: ["string", "number", "null"], description: "Either." },
      },
    })).toEqual(["value: authored-null-branch-not-delivered"]);
  });
});
