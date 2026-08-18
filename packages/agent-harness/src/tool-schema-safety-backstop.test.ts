import { describe, expect, it, vi } from "vitest";

/**
 * The one path `repairRootUnionForProviders` still has, exercised.
 *
 * Everything else about that function is the no-op gate: under bind 13 the
 * sanitizer handles every shape, so the drop never fires and every assertion in
 * the main file lands on `toBe(schema)`. That is correct behaviour and it is
 * also the problem — the drop is the entire justification for gating this
 * backstop rather than deleting it, and an unexercised backstop rots exactly as
 * quietly as a deleted one. Disabling the gate outright left the whole suite
 * green before this file existed.
 *
 * A real fatal root union cannot be produced through bind 13, which is the point
 * of the release, so the sanitizer is stubbed to hand back one. That makes this
 * a test of Avalon's drop, not of the dependency — which is what is wanted here.
 * The unmocked behaviour stays covered next door.
 */
vi.mock("@juno-ai/bind/tools", () => ({
  // Identity: whatever is authored is what "reaches the wire", so a schema
  // written with an unusable root branch still has one after sanitization.
  sanitizeToolSchema: (schema: Record<string, unknown>) => schema,
}));

const { repairRootUnionForProviders } = await import("./tool-schema-safety");

describe("repairRootUnionForProviders, when the sanitizer leaves something fatal", () => {
  it("drops every root union and keeps the rest of the schema", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a"],
      description: "kept",
      oneOf: [{ required: ["a"] }],
      anyOf: [{ required: ["b"] }],
    };

    expect(repairRootUnionForProviders(schema)).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a"],
      description: "kept",
    });
  });

  it("drops both keywords even when only one carries the unusable branch", () => {
    // Once anything fatal survives sanitization, no root union on the schema is
    // trustworthy: an authored branch can read as usable while its sanitized
    // form does not, so the drop is deliberately not selective.
    const schema = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      oneOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }],
      anyOf: [{ required: ["b"] }],
    };

    const repaired = repairRootUnionForProviders(schema);

    expect(repaired.oneOf).toBeUndefined();
    expect(repaired.anyOf).toBeUndefined();
  });

  it("does not mutate the schema it was given", () => {
    // The sibling assertion in the main file now takes the no-op path, so this
    // is the only cover for the branch that could actually mutate.
    const schema = {
      type: "object",
      properties: { a: { type: "string" } },
      oneOf: [{ required: ["ghost"] }],
    };

    repairRootUnionForProviders(schema);

    expect(schema.oneOf).toEqual([{ required: ["ghost"] }]);
    expect(Object.keys(schema)).toContain("oneOf");
  });
});
