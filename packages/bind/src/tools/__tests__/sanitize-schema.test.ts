import { describe, expect, test } from "vitest";
import { sanitizeToolSchema } from "../sanitize-schema";

const obj = (v: unknown): Record<string, unknown> =>
  v as Record<string, unknown>;

/**
 * Sanitize a NODE by nesting it under a property, and return the sanitized
 * node. The scalar transforms (#1 `type` arrays, #2 `enum`, and the
 * description-folding that goes with them) are per-node rules, and a property
 * subschema is where they actually apply — a tool's parameters ROOT is an
 * object by definition, and transform #9 now rewrites one that isn't (measured:
 * a scalar root is rejected by every Grok and by gpt-5.6-sol, and a root whose
 * `type` contradicts its `properties` is rejected by all nine). Passing a bare
 * scalar as the whole schema would therefore test the root rewrite rather than
 * the transform under test.
 */
const atProperty = (node: Record<string, unknown>): Record<string, unknown> =>
  obj(
    obj(sanitizeToolSchema({ type: "object", properties: { v: node } }).properties)
      .v,
  );

describe("sanitizeToolSchema", () => {
  test("drops a required entry not present in sibling properties (top level)", () => {
    const result = sanitizeToolSchema({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a", "ghost"],
    });
    expect(result.required).toEqual(["a"]);
  });

  test("reproduces the production failure: dangling required inside array items", () => {
    // GitHub MCP `issue_write` shape: `issue_fields` is an array whose item
    // schema's `required` named a property the item didn't declare. Gemini
    // rejected the whole request on this.
    const result = sanitizeToolSchema({
      type: "object",
      properties: {
        issue_fields: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["value"], // not declared in properties above
          },
        },
      },
    });
    const issueFields = obj(obj(result.properties).issue_fields);
    const items = obj(issueFields.items);
    expect(items.required).toBeUndefined();
    // The valid structure around it is preserved.
    expect(obj(items.properties).name).toEqual({ type: "string" });
  });

  test("keeps required entries that ARE declared properties", () => {
    const result = sanitizeToolSchema({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a", "b"],
    });
    expect(result.required).toEqual(["a", "b"]);
  });

  test("omits an entirely-invalid required array rather than emitting []", () => {
    const result = sanitizeToolSchema({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["ghost"],
    });
    expect("required" in result).toBe(false);
  });

  test("drops required when the node declares no properties at all", () => {
    const result = sanitizeToolSchema({
      type: "object",
      required: ["anything"],
    });
    expect("required" in result).toBe(false);
  });

  test("recurses through allOf / anyOf / oneOf branches", () => {
    const result = sanitizeToolSchema({
      anyOf: [
        {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a", "ghost"],
        },
      ],
    });
    expect(obj((result.anyOf as unknown[])[0]).required).toEqual(["a"]);
  });

  test("recurses through $defs / definitions", () => {
    const result = sanitizeToolSchema({
      $defs: {
        Thing: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id", "missing"],
        },
      },
    });
    expect(obj(obj(result.$defs).Thing).required).toEqual(["id"]);
  });

  describe("transform #13 — unsupported regex constructs in `pattern`", () => {
    // The class of defect that broke Monad's own `spaces__invite_member` on
    // every OpenAI model. Each verdict below is a live measurement.
    const dropped: [string, string][] = [
      ["lookahead", "^(?=.*@).+$"],
      ["negative lookahead", "^(?!admin).+$"],
      ["lookbehind", "(?<=@)\\w+"],
      ["named group", "(?<user>\\w+)@\\w+"],
      ["named backreference", "^(?<n>a)\\k<n>$"],
      ["numeric backreference", "^(a)\\1$"],
      ["atomic group", "^(?>a|b)+$"],
      // Providers close a character class at the FIRST `]` rather than honouring
      // the RFC's leading-`]`-is-literal rule, so this `(?=` reads as OUTSIDE
      // the class to them: rejected by gpt-5.6-sol/terra, and dropped here.
      ["lookahead after a `[]` class", "^[](?=)]+$"],
    ];
    for (const [label, pattern] of dropped) {
      test(`drops a ${label} and records it in the description`, () => {
        const result = atProperty({ type: "string", pattern });
        expect("pattern" in result).toBe(false);
        expect(result.description).toBe(`Should match the pattern ${pattern}.`);
      });
    }

    const kept: [string, string][] = [
      ["non-capturing group", "^(?:a|b)+$"],
      ["inline flags", "(?i)^abc$"],
      ["plain regex", "^[a-z]+@[a-z]+\\.[a-z]+$"],
      // Escaped — a literal `(`, `?`, `=`, not a lookahead.
      ["escaped literal `(?=`", "^\\(\\?=x$"],
      // Inside a character class under the naive parse providers use.
      ["`(?=` inside a character class", "^[(?=]+$"],
      ["negated class containing `]`", "^[^]]+$"],
    ];
    for (const [label, pattern] of kept) {
      test(`keeps a ${label} — every provider accepts it`, () => {
        const result = atProperty({ type: "string", pattern });
        expect(result.pattern).toBe(pattern);
        expect("description" in result).toBe(false);
      });
    }

    test("truncates a very long pattern echoed into the description", () => {
      const pattern = `^(?=${"a".repeat(400)}).+$`;
      const result = atProperty({ type: "string", pattern });
      expect("pattern" in result).toBe(false);
      expect(String(result.description).length).toBeLessThan(200);
      expect(String(result.description)).toContain("…");
    });

    test("appends to an existing description rather than replacing it", () => {
      const result = atProperty({
        type: "string",
        pattern: "^(?=.*@).+$",
        description: "The email.",
      });
      expect(result.description).toBe(
        "The email. Should match the pattern ^(?=.*@).+$.",
      );
    });
  });

  test("keeps `const` verbatim (Gemini supports it; converting to enum would be harmful)", () => {
    // Gemini accepts `const` on every type. Converting `const: 5` → `enum: [5]`
    // would manufacture a non-string enum, which Gemini REJECTS — so we must
    // not transform const.
    expect(atProperty({ type: "string", const: "fixed" }).const).toBe("fixed");
    expect(atProperty({ type: "number", const: 5 }).const).toBe(5);
    expect(atProperty({ type: "boolean", const: true }).const).toBe(true);
  });

  test("collapses a MULTI-type `type` ARRAY to the first non-null type", () => {
    // Gemini requires a scalar `type` and rejects a union array. A genuine
    // multi-type union has no shape every provider accepts, so it collapses and
    // the alternatives become prose. (A NULLABLE single type does have one — it
    // is rewritten to an `anyOf`; see the dedicated describe block below.)
    expect(atProperty({ type: ["string", "number", "boolean"] }).type).toBe(
      "string",
    );
    expect(atProperty({ type: ["number", "string", "null"] }).type).toBe("number");
    // A nested property's type array is collapsed too.
    const nested = sanitizeToolSchema({
      type: "object",
      properties: { v: { type: ["integer", "boolean"] } },
    });
    expect(obj(obj(nested.properties).v).type).toBe("integer");
  });

  test("drops a `type`-only-null array (no usable scalar type)", () => {
    expect("type" in atProperty({ type: ["null"] })).toBe(false);
  });

  test("drops `enum` on every explicit non-string type", () => {
    // Gemini accepts enum only on `type: string`.
    for (const type of ["boolean", "number", "integer", "array", "object", "null"]) {
      const r = atProperty({ type, enum: ["a", "b"] });
      expect(`enum on type=${type}: ${"enum" in r}`).toBe(`enum on type=${type}: false`);
    }
    expect(atProperty({ type: "string", enum: ["a", "b"] }).enum).toEqual([
      "a",
      "b",
    ]);
  });

  test("filters a string-typed `enum` to its string members (drops non-string leftovers)", () => {
    // Gemini rejects an enum containing any non-string value, even on a string
    // type — including leftovers after a union `type` collapsed to "string".
    expect(atProperty({ type: "string", enum: ["a", 1, "b", true] }).enum).toEqual([
      "a",
      "b",
    ]);
    // Type-array collapse + enum filter compose: ["string","number"] → "string",
    // enum ["a", 1] → ["a"].
    const collapsed = atProperty({ type: ["string", "number"], enum: ["a", 1] });
    expect(collapsed.type).toBe("string");
    expect(collapsed.enum).toEqual(["a"]);
    // No string members remain → drop the enum entirely.
    expect("enum" in atProperty({ type: "string", enum: [1, 2] })).toBe(false);
  });

  test("a type-less `enum` is filtered to strings (drops a fully non-string enum)", () => {
    expect(atProperty({ enum: ["a", 1, "b"] }).enum).toEqual(["a", "b"]);
    expect("enum" in atProperty({ enum: [1, 2] })).toBe(false);
  });

  test("multi-type collapse and enum-drop compose (boolean union)", () => {
    // ["boolean","number"] → "boolean", and the boolean enum is dropped.
    const r = atProperty({ type: ["boolean", "number"], enum: [true] });
    expect(r.type).toBe("boolean");
    expect("enum" in r).toBe(false);
  });

  test("a nullable type whose `enum` excludes null keeps the collapse", () => {
    // `enum` is AND-ed with `type`, so `{type:["boolean","null"], enum:[true]}`
    // means "must be true" — null is not actually reachable. Rewriting would
    // move the `enum` onto the typed branch and leave `{type:"null"}`
    // unconstrained by it, admitting a value the node forbade.
    const r = atProperty({ type: ["boolean", "null"], enum: [true] });
    expect(r).toEqual({
      type: "boolean",
      description: "Accepts boolean or null. Allowed values: true.",
    });
  });

  test("keeps both `const` and a string `enum` when present (cumulative, both valid)", () => {
    // Gemini accepts `const` and string `enum` independently; we keep both
    // verbatim (no merge) — faithful to the source and not Gemini-hostile.
    const r = atProperty({ type: "string", const: "foo", enum: ["foo", "bar"] });
    expect(r.const).toBe("foo");
    expect(r.enum).toEqual(["foo", "bar"]);
  });

  // --- Transform #1, nullable case: `{type:["T","null"]}` becomes a real
  // `anyOf` union rather than collapsing to T with a prose note. The collapse
  // was lossy in a way that broke callers: a model reading
  // `{type:"string", minLength:1, description:"… or send null …"}` cannot
  // express "none" in the half of the declaration it treats as binding, so it
  // invents a value that satisfies the type — `slack_send_message.thread_ts`
  // (authored `type:["string","null"], minLength:1`) took `"/"`, `". "` and
  // `".000001"` for thousands of calls, each refused by Slack and retried. The
  // `anyOf` shape is measured accepted on grok-4.3/4.5/4.6,
  // gemini-3.5/3.6/3.7-flash and gpt-5.6-terra/sol/luna. ----------------------

  describe("rewrites a nullable single type to an anyOf union", () => {
    /** Every fixture in this block, re-sanitized in place, must be unchanged. */
    const expectIdempotent = (node: Record<string, unknown>): void => {
      const once = atProperty(node);
      expect(atProperty(once)).toEqual(once);
    };

    test("moves the type-bearing keywords onto the branch, annotations stay out", () => {
      const node = { type: ["string", "null"], minLength: 1, description: "d" };
      expect(atProperty(node)).toEqual({
        anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
        description: "d",
      });
      // The schema now says "or null", so the prose note that used to say it is
      // gone — and `description` is NOT duplicated into the branch.
      expect(atProperty(node).description).toBe("d");
      expectIdempotent(node);
    });

    test("member order and duplicates do not matter", () => {
      const expected = {
        anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
        description: "d",
      };
      const reversed = { type: ["null", "string"], minLength: 1, description: "d" };
      const duplicated = {
        type: ["string", "null", "null"],
        minLength: 1,
        description: "d",
      };
      expect(atProperty(reversed)).toEqual(expected);
      expect(atProperty(duplicated)).toEqual(expected);
      expectIdempotent(reversed);
      expectIdempotent(duplicated);
    });

    test("numeric bounds move onto the branch", () => {
      const node = { type: ["integer", "null"], minimum: 1 };
      expect(atProperty(node)).toEqual({
        anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }],
      });
      expectIdempotent(node);
    });

    test("object structure moves onto the branch, and its `required` resolves there", () => {
      // Transform #3 runs on the branch like any other node: `required` is
      // checked against the branch's OWN `properties`, which is where the map
      // now lives.
      const node = {
        type: ["object", "null"],
        properties: { a: { type: "string" } },
        required: ["a"],
      };
      expect(atProperty(node)).toEqual({
        anyOf: [
          {
            type: "object",
            properties: { a: { type: "string" } },
            required: ["a"],
          },
          { type: "null" },
        ],
      });
      // A `required` the branch cannot satisfy is still pruned on the branch.
      expect(
        atProperty({
          type: ["object", "null"],
          properties: { a: { type: "string" } },
          required: ["a", "ghost"],
        }),
      ).toEqual({
        anyOf: [
          {
            type: "object",
            properties: { a: { type: "string" } },
            required: ["a"],
          },
          { type: "null" },
        ],
      });
      expectIdempotent(node);
    });

    test("an `enum` contributes its non-null members and earns no null note", () => {
      // The `{type:"null"}` branch already carries "null is allowed", so
      // transform #2's "May also be null." note would be redundant.
      const node = { type: ["string", "null"], enum: ["a", "b", null] };
      const result = atProperty(node);
      expect(result).toEqual({
        anyOf: [{ type: "string", enum: ["a", "b"] }, { type: "null" }],
      });
      expect("description" in result).toBe(false);
      expectIdempotent(node);
    });

    test("a mixed `enum` filters on the branch and notes the dropped members there", () => {
      // `["a", 1, null]` permits both arms, so the rewrite fires; `null` is
      // stripped on the way in, then the branch's own transform #2 filters the
      // non-string member and records it in the BRANCH's description.
      const node = { type: ["string", "null"], enum: ["a", 1, null] };
      expect(atProperty(node)).toEqual({
        anyOf: [
          { type: "string", enum: ["a"], description: "May also be 1." },
          { type: "null" },
        ],
      });
      expectIdempotent(node);
    });

    test("a sibling `enum`/`const` that excludes an arm keeps the collapse", () => {
      // Both keywords are AND-ed with `type`, so they decide whether the two
      // arms the type array advertises are really reachable. The union may only
      // emit an arm the node actually allows.
      const enumExcludesNull = { type: ["string", "null"], enum: ["x"] };
      expect(atProperty(enumExcludesNull)).toEqual({
        type: "string",
        enum: ["x"],
        description: "Accepts string or null.",
      });

      const constExcludesNull = { type: ["string", "null"], const: "x" };
      expect(atProperty(constExcludesNull)).toEqual({
        type: "string",
        const: "x",
        description: "Accepts string or null.",
      });

      expectIdempotent(enumExcludesNull);
      expectIdempotent(constExcludesNull);
    });

    test("`const: null` still rewrites — the union is what the node means", () => {
      // Collapsing would give the unsatisfiable `{type:"string", const:null}`.
      // The union's typed branch is unsatisfiable instead, so it reduces to
      // "must be null" — exactly what `type:["string","null"] + const:null`
      // says.
      const node = { type: ["string", "null"], const: null };
      expect(atProperty(node)).toEqual({
        anyOf: [{ type: "string", const: null }, { type: "null" }],
      });
      expectIdempotent(node);
    });

    test("a supported `pattern` rides the branch; an unsupported one becomes branch prose", () => {
      const kept = { type: ["string", "null"], pattern: "^\\d+\\.\\d+$" };
      expect(atProperty(kept)).toEqual({
        anyOf: [
          { type: "string", pattern: "^\\d+\\.\\d+$" },
          { type: "null" },
        ],
      });
      // Transform #13 applies to the branch exactly as it does to a scalar node.
      const dropped = { type: ["string", "null"], pattern: "^(?=x)\\d+$" };
      expect(atProperty(dropped)).toEqual({
        anyOf: [
          {
            type: "string",
            description: "Should match the pattern ^(?=x)\\d+$.",
          },
          { type: "null" },
        ],
      });
      expectIdempotent(kept);
      expectIdempotent(dropped);
    });

    test("applies under `items`, under `$defs`, and inside a non-root union branch", () => {
      const nullable = { type: ["string", "null"], minLength: 1 };
      const union = [{ type: "string", minLength: 1 }, { type: "null" }];

      const inItems = atProperty({ type: "array", items: nullable });
      expect(inItems.items).toEqual({ anyOf: union });

      const inDefs = sanitizeToolSchema({
        type: "object",
        properties: { a: { $ref: "#/$defs/N" } },
        $defs: { N: nullable },
      });
      expect(obj(inDefs.$defs).N).toEqual({ anyOf: union });

      // A NON-root `anyOf` — the root-union rules never see it.
      const inBranch = atProperty({ anyOf: [nullable, { type: "number" }] });
      expect(inBranch.anyOf).toEqual([{ anyOf: union }, { type: "number" }]);

      expectIdempotent({ type: "array", items: nullable });
      expectIdempotent({ anyOf: [nullable, { type: "number" }] });
    });

    test("a multi-type union still collapses with its note (unchanged)", () => {
      const node = { type: ["string", "number", "null"] };
      const result = atProperty(node);
      expect(result.type).toBe("string");
      expect(result.description).toBe("Accepts string, number, or null.");
      expect("anyOf" in result).toBe(false);
      expectIdempotent(node);
    });

    test("the parameters ROOT is never rewritten into a union", () => {
      // Every provider requires the root to be an object, so transform #9's
      // root handling wins: the type array collapses and the loss is prose.
      const result = sanitizeToolSchema({
        type: ["object", "null"],
        properties: { a: { type: "string" } },
      });
      expect(result).toEqual({
        type: "object",
        properties: { a: { type: "string" } },
        description: "Accepts object or null.",
      });
      expect(sanitizeToolSchema(result)).toEqual(result);
    });

    test("a branch of a ROOT union is never rewritten (it would drop the keyword)", () => {
      // A root union branch carrying its own `anyOf` is 0/3 on Grok, so
      // rewriting here would make transform #9 rule (a) drop the whole keyword
      // — losing every shape the union advertised. The branch keeps the
      // collapse and stays usable.
      const result = sanitizeToolSchema({
        anyOf: [
          { type: ["object", "null"], properties: { a: { type: "string" } } },
          { type: "object", properties: { b: { type: "string" } } },
        ],
      });
      expect(result.anyOf).toEqual([
        {
          type: "object",
          properties: { a: { type: "string" } },
          description: "Accepts object or null.",
        },
        { type: "object", properties: { b: { type: "string" } } },
      ]);
      expect(sanitizeToolSchema(result)).toEqual(result);
    });

    test("the object-structure keywords move as a group, keeping their sibling scope", () => {
      // `additionalProperties` is defined against the keys `properties` and
      // `patternProperties` did NOT match IN THE SAME schema object. Stranding
      // `patternProperties` on the outer node while the other two move would
      // silently re-scope it: `x1` matches `^x`, so it is exempt from
      // `additionalProperties` — and split across the union boundary it stops
      // being exempt, a constraint the author never wrote.
      const node = {
        type: ["object", "null"],
        properties: { a: { type: "string" } },
        patternProperties: { "^x": { type: "number" } },
        additionalProperties: { type: "string" },
        dependentRequired: { a: ["b"] },
      };
      const result = atProperty(node);
      expect(result).toEqual({
        anyOf: [
          {
            type: "object",
            properties: { a: { type: "string" } },
            patternProperties: { "^x": { type: "number" } },
            additionalProperties: { type: "string" },
            dependentRequired: { a: ["b"] },
          },
          { type: "null" },
        ],
      });
      expectIdempotent(node);
    });

    test("`unevaluatedProperties` deliberately stays on the outer node", () => {
      // It is defined over the annotations every applicable schema produced —
      // the `anyOf` branches included — so the outer node is where it can see
      // them. Moving it inside would narrow it to the branch's own keywords.
      const node = {
        type: ["object", "null"],
        properties: { a: { type: "string" } },
        unevaluatedProperties: false,
      };
      expect(atProperty(node)).toEqual({
        anyOf: [
          { type: "object", properties: { a: { type: "string" } } },
          { type: "null" },
        ],
        unevaluatedProperties: false,
      });
      expectIdempotent(node);
    });

    test("a composition branch whose `required` is self-contained IS rewritten", () => {
      // The exception below exists for a `required` that reaches the enclosing
      // node's `properties`. One the branch declares itself needs no exception,
      // and declining there would keep the invented-value failure for nothing.
      const node = {
        type: "object",
        properties: { a: { type: "string" } },
        oneOf: [
          {
            type: ["object", "null"],
            properties: { b: { type: "string" } },
            required: ["b"],
          },
        ],
      };
      expect(atProperty(node).oneOf).toEqual([
        {
          anyOf: [
            {
              type: "object",
              properties: { b: { type: "string" } },
              required: ["b"],
            },
            { type: "null" },
          ],
        },
      ]);
      expectIdempotent(node);
    });

    test("a composition branch whose `required` reaches the parent keeps the collapse", () => {
      // Transform #8 resolves such a `required` against the ENCLOSING node's
      // `properties`. Rewriting the branch would nest it one level further
      // down, out of that scope — and the branch, having no `properties` of its
      // own, would then lose the `required` entirely to transform #3.
      const node = {
        type: "object",
        properties: { a: { type: "string" } },
        oneOf: [{ type: ["object", "null"], required: ["a"] }],
      };
      expect(atProperty(node).oneOf).toEqual([
        {
          type: "object",
          required: ["a"],
          description: "Accepts object or null.",
        },
      ]);
      expectIdempotent(node);
    });

    test("a `type`-only-null array still just drops the type", () => {
      const result = atProperty({ type: ["null"] });
      expect("anyOf" in result).toBe(false);
      expect("type" in result).toBe(false);
      expect(result.description).toBe("Must be null.");
    });

    test("an all-null `enum` keeps the collapse (the branch would allow anything)", () => {
      // With every enum member dropped the typed branch would carry no allowed
      // value at all, widening the schema instead of describing it.
      const result = atProperty({ type: ["string", "null"], enum: [null] });
      expect("anyOf" in result).toBe(false);
      expect(result.type).toBe("string");
      expect(result.description).toBe("Accepts string or null. Allowed values: null.");
    });

    test("a property NAMED `type` is data, not the keyword", () => {
      // The walk is keyword-aware: a `properties` entry called `type` is a
      // property name. Its own subschema is still sanitized (so a nullable one
      // is rewritten), but a bare array sitting there is opaque data.
      const asSubschema = sanitizeToolSchema({
        type: "object",
        properties: { type: { type: ["string", "null"] } },
      });
      expect(obj(asSubschema.properties).type).toEqual({
        anyOf: [{ type: "string" }, { type: "null" }],
      });

      const asRawArray = sanitizeToolSchema({
        type: "object",
        properties: { type: ["string", "null"] },
      });
      expect(obj(asRawArray.properties).type).toEqual(["string", "null"]);
      expect(sanitizeToolSchema(asRawArray)).toEqual(asRawArray);
    });

    test("a nullable node deep under the walk still rewrites (depth budget unchanged)", () => {
      // `buildNullableBranch` re-enters at the node's OWN depth, not one
      // deeper, because the branch is a re-expression of the node rather than a
      // new level. Pin that: a nullable leaf far down the walk must still get
      // its union, which a switch to `childDepth` would eventually cost it.
      const DEPTH = 95; // MAX_DEPTH is 100
      let node: Record<string, unknown> = {
        type: ["string", "null"],
        minLength: 1,
      };
      for (let i = 0; i < DEPTH; i++) {
        node = { type: "object", properties: { x: node } };
      }
      let walked = obj(sanitizeToolSchema(node));
      for (let i = 0; i < DEPTH; i++) {
        walked = obj(obj(walked.properties).x);
      }
      expect(walked).toEqual({
        anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
      });
    });

    test("the production shape: a nullable, length-bounded cursor parameter", () => {
      // `slack_send_message.thread_ts` as authored. The emitted union is the
      // shape six connectors' pagination cursors already ship in production.
      const result = sanitizeToolSchema({
        type: "object",
        properties: {
          thread_ts: {
            type: ["string", "null"],
            minLength: 1,
            description: "Thread timestamp, or null for a top-level message.",
          },
        },
      });
      expect(obj(result.properties).thread_ts).toEqual({
        anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
        description: "Thread timestamp, or null for a top-level message.",
      });
    });
  });

  // --- Description data-keeping: no transform must ever lose existing
  // `description` text, and lossy transforms must fold their info into it ---

  describe("description data-keeping", () => {
    test("leaves an existing description untouched when nothing is dropped", () => {
      expect(
        atProperty({ type: "string", description: "A plain string." }).description,
      ).toBe("A plain string.");
      // No transform, no description manufactured.
      expect("description" in atProperty({ type: "string" })).toBe(false);
    });

    test("appends a union-type note to an existing description (preserving it)", () => {
      expect(
        atProperty({
          type: ["string", "number", "boolean"],
          description: "The value.",
        }).description,
      ).toBe("The value. Accepts string, number, or boolean.");
    });

    test("appends a dropped-enum note to an existing description (preserving it)", () => {
      expect(
        atProperty({
          type: "boolean",
          enum: [true],
          description: "Clear it.",
        }).description,
      ).toBe("Clear it. Allowed values: true.");
    });

    test("combines a type note and an enum note in order, after the original text", () => {
      // type ["string","number"] → "string" (note), enum ["a",1] → ["a"]
      // (partial-filter note for the dropped 1).
      const r = atProperty({
        type: ["string", "number"],
        enum: ["a", 1],
        description: "X.",
      });
      expect(r.type).toBe("string");
      expect(r.enum).toEqual(["a"]);
      expect(r.description).toBe("X. Accepts string or number. May also be 1.");
    });

    test("manufactures a description only when none existed", () => {
      const r = atProperty({ type: "number", enum: [1, 2] });
      expect("enum" in r).toBe(false);
      expect(r.description).toBe("Allowed values: 1, 2.");
    });

    test("preserves and augments descriptions nested deep in the tree", () => {
      const r = sanitizeToolSchema({
        type: "object",
        properties: {
          rows: {
            type: "array",
            items: {
              type: "object",
              properties: {
                flag: {
                  type: "boolean",
                  enum: [true],
                  description: "The flag.",
                },
                kept: { type: "string", description: "Untouched." },
              },
            },
          },
        },
      });
      const itemProps = obj(obj(obj(obj(r.properties).rows).items).properties);
      expect(obj(itemProps.flag).description).toBe("The flag. Allowed values: true.");
      expect(obj(itemProps.kept).description).toBe("Untouched.");
    });

    test("a non-string description is preserved verbatim (not corrupted)", () => {
      // Malformed but we must not lose/mangle it.
      const r = atProperty({ type: "boolean", enum: [true], description: 42 });
      expect(r.description).toBe(42);
    });
  });

  test("PRODUCTION ROOT CAUSE: real issue_write `issue_fields.items` shape is made Gemini-safe", () => {
    // The actual failing schema: `value` typed with a type array, `delete`
    // with a boolean enum, and a valid `required: ["field_name"]`. After
    // sanitization there are no type arrays and no non-string enums, and the
    // (valid) required survives.
    const result = sanitizeToolSchema({
      type: "object",
      properties: {
        issue_fields: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              field_name: { type: "string" },
              field_option_name: { type: "string" },
              value: { type: ["string", "number", "boolean"] },
              delete: { type: "boolean", enum: [true] },
            },
            required: ["field_name"],
          },
        },
      },
      required: ["method"],
    });
    const items = obj(obj(obj(result.properties).issue_fields).items);
    const props = obj(items.properties);
    expect(obj(props.value).type).toBe("string"); // type array collapsed
    expect("enum" in obj(props.delete)).toBe(false); // boolean enum dropped
    expect(obj(props.delete).type).toBe("boolean");
    expect("additionalProperties" in items).toBe(false); // transform #6 drops the boolean false
    expect(items.required).toEqual(["field_name"]); // valid required kept
    expect("required" in result).toBe(false); // top "method" pruned (no properties here)
  });

  test("strips $schema but preserves $id (base URI for relative $ref)", () => {
    const result = sanitizeToolSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "urn:x",
      type: "object",
      properties: { a: { $ref: "#/$defs/Thing" } },
      $defs: { Thing: { type: "string" } },
    });
    expect("$schema" in result).toBe(false);
    expect(result.$id).toBe("urn:x");
    expect(result.type).toBe("object");
    // A resolvable `$ref` is preserved wherever it appears below the root.
    expect(obj(obj(result.properties).a).$ref).toBe("#/$defs/Thing");
  });

  test("drops a `const` or `$ref` carried by the ROOT (transform #9)", () => {
    // Measured on grok-4.5: `root schema is a const` / `root schema is a $ref`,
    // both 400 even when the root also declares `type: "object"` AND
    // `properties`, and the `$ref` case even when the target resolves. Neither
    // can describe a callable argument object. Nested `const`/`$ref` are
    // meaningful and untouched (covered by the tests above).
    const withConst = sanitizeToolSchema({
      type: "object",
      properties: { a: { type: "string" } },
      const: "pinned",
    });
    expect("const" in withConst).toBe(false);
    expect(withConst.description).toBe(
      'Pinned to a single value ("pinned") at the schema root.',
    );
    expect(Object.keys(obj(withConst.properties))).toEqual(["a"]);

    const withRef = sanitizeToolSchema({
      type: "object",
      $ref: "#/$defs/Thing",
      $defs: { Thing: { type: "object", properties: { a: { type: "string" } } } },
    });
    expect("$ref" in withRef).toBe(false);
    expect(withRef.type).toBe("object");
    expect(withRef.$defs).toBeDefined();
  });

  test("drops a `$ref` whose local target does not resolve (transform #11)", () => {
    // xAI resolves `#/...` itself and 400s the whole request on a dangling one:
    // `unresolvable $ref '#/$defs/Nope': key 'Nope' not found under '#/$defs'`.
    const result = sanitizeToolSchema({
      type: "object",
      properties: {
        good: { $ref: "#/$defs/Known" },
        dangling: { $ref: "#/$defs/Nope" },
        selfPointer: { $ref: "#/properties/good" },
        external: { $ref: "https://example.com/s.json" },
        noDefsAtAll: { type: "object", properties: { x: { $ref: "#/nope/nope" } } },
      },
      $defs: { Known: { type: "string" } },
    });
    const props = obj(result.properties);
    expect(obj(props.good).$ref).toBe("#/$defs/Known");
    expect("$ref" in obj(props.dangling)).toBe(false);
    // A resolvable non-`$defs` pointer and an external ref are both accepted
    // by xAI and left alone.
    expect(obj(props.selfPointer).$ref).toBe("#/properties/good");
    expect(obj(props.external).$ref).toBe("https://example.com/s.json");
    expect("$ref" in obj(obj(obj(props.noDefsAtAll).properties).x)).toBe(false);
  });

  test("drops a boolean additionalProperties: false (xAI rejects it) but keeps the rest", () => {
    // transform #6: Grok 400s on `additionalProperties: false`; it's advisory
    // for tool calling, so drop it without disturbing siblings.
    const result = sanitizeToolSchema({
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: false,
    });
    expect("additionalProperties" in result).toBe(false);
    expect(result.properties).toEqual({ a: { type: "string" } });
  });

  test("a nested additionalProperties: false (not under a `properties`-named field) is dropped", () => {
    // transform #6 in isolation: an object-shaped node named something other than
    // `properties` keeps its type but loses the boolean-false additionalProperties.
    const result = sanitizeToolSchema({
      type: "object",
      properties: {
        rows: {
          type: "array",
          items: {
            type: "object",
            properties: {
              meta: { type: "object", additionalProperties: false },
            },
          },
        },
      },
    });
    const meta = obj(
      obj(obj(obj(obj(result.properties).rows).items).properties).meta,
    );
    expect("additionalProperties" in meta).toBe(false);
    expect(meta.type).toBe("object");
  });

  test("keeps additionalProperties: true (no-op default, accepted everywhere)", () => {
    const result = sanitizeToolSchema({
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: true,
    });
    expect(result.additionalProperties).toBe(true);
  });

  describe("transform #7: neutralize an object-shaped property named `properties` (xAI/Grok)", () => {
    test("PRODUCTION ROOT CAUSE: the Notion pages[].properties.properties field is collapsed to annotations", () => {
      // The real `notion-create-pages` shape. xAI mis-reads a field literally
      // named `properties` as the schema keyword and 400s the whole request, so
      // the object-shaped node is collapsed to `{ description }` — the key name
      // is preserved so the model still emits the right argument.
      const result = sanitizeToolSchema({
        type: "object",
        properties: {
          pages: {
            type: "array",
            items: {
              type: "object",
              properties: {
                properties: {
                  type: "object",
                  description: "The page properties.",
                  additionalProperties: false,
                },
                content: { type: "string" },
              },
              required: ["properties"],
            },
          },
        },
      });
      const item = obj(obj(obj(obj(result.properties).pages).items));
      const pageProps = obj(obj(item.properties).properties);
      // Object-shape keywords are gone; only the description survives.
      expect(pageProps).toEqual({ description: "The page properties." });
      // Siblings and the (valid) required are untouched; the key name is kept.
      expect(obj(obj(item.properties).content).type).toBe("string");
      expect(item.required).toEqual(["properties"]);
    });

    test("synthesizes a description when the collapsed node had none", () => {
      const result = sanitizeToolSchema({
        type: "object",
        properties: { properties: { type: "object", properties: { a: { type: "string" } } } },
      });
      expect(obj(obj(result.properties).properties)).toEqual({ description: "An object." });
    });

    test("object-shape via nested `properties` or `additionalProperties` (no explicit type) is still collapsed", () => {
      const viaNested = sanitizeToolSchema({
        type: "object",
        properties: { properties: { properties: { a: { type: "string" } } } },
      });
      expect(obj(obj(viaNested.properties).properties)).toEqual({ description: "An object." });

      const viaAddl = sanitizeToolSchema({
        type: "object",
        properties: { properties: { additionalProperties: { type: "string" } } },
      });
      expect(obj(obj(viaAddl.properties).properties)).toEqual({ description: "An object." });
    });

    test("object-shape via patternProperties (no type, no properties) is still collapsed", () => {
      const result = sanitizeToolSchema({
        type: "object",
        properties: {
          properties: { patternProperties: { "^x-": { type: "string" } } },
        },
      });
      expect(obj(obj(result.properties).properties)).toEqual({ description: "An object." });
    });

    test("keeps opaque data keywords (default / examples / const) on the collapsed node", () => {
      // Verified live that xAI does not descend into these, so they're retained
      // as model guidance while the object STRUCTURE is dropped.
      const result = sanitizeToolSchema({
        type: "object",
        properties: {
          properties: {
            type: "object",
            description: "Page props.",
            additionalProperties: false,
            default: { x: 1 },
            examples: [{ y: 2 }],
            const: { z: 3 },
          },
        },
      });
      expect(obj(obj(result.properties).properties)).toEqual({
        description: "Page props.",
        default: { x: 1 },
        examples: [{ y: 2 }],
        const: { z: 3 },
      });
    });

    test("a NON-object `properties` field (e.g. type: string) is left untouched", () => {
      const result = sanitizeToolSchema({
        type: "object",
        properties: { properties: { type: "string", description: "A string." } },
      });
      expect(obj(obj(result.properties).properties)).toEqual({
        type: "string",
        description: "A string.",
      });
    });

    test("an object field with any OTHER name is untouched (only `properties` collides)", () => {
      const result = sanitizeToolSchema({
        type: "object",
        properties: { config: { type: "object", properties: { a: { type: "string" } } } },
      });
      const config = obj(obj(result.properties).config);
      expect(config.type).toBe("object");
      expect(obj(config.properties).a).toEqual({ type: "string" });
    });

    test("preserves `title` on the collapsed node", () => {
      const result = sanitizeToolSchema({
        type: "object",
        properties: { properties: { type: "object", title: "Props", description: "D." } },
      });
      expect(obj(obj(result.properties).properties)).toEqual({ title: "Props", description: "D." });
    });
  });

  test("preserves meaningful keywords (format, pattern, bounds)", () => {
    const result = atProperty({
      type: "string",
      format: "email",
      pattern: "^x",
      minLength: 1,
      maxLength: 5,
    });
    expect(result).toMatchObject({
      type: "string",
      format: "email",
      pattern: "^x",
      minLength: 1,
      maxLength: 5,
    });
  });

  test("does not treat a tool parameter literally named 'required' as a keyword's data", () => {
    // A property whose value is itself a schema is a real schema position —
    // but the property NAME 'required' must still be matchable by the
    // parent's required list. The `properties`-named child is non-object here so
    // this stays focused on the `required`-name concern (an object-shaped one
    // would be neutralized by transform #7 — covered separately above).
    const result = sanitizeToolSchema({
      type: "object",
      properties: {
        required: { type: "array", items: { type: "string" } },
        properties: { type: "string" },
      },
      required: ["required", "properties"],
    });
    expect(result.required).toEqual(["required", "properties"]);
  });

  test("does not recurse into enum/default/example data values", () => {
    // An example value that happens to contain `required`/`properties` keys
    // is opaque data, not schema structure — it must survive untouched.
    const opaque = {
      type: "object",
      properties: { cfg: { type: "object" } },
      default: { properties: {}, required: ["should-not-be-pruned"] },
      examples: [{ required: ["x"], properties: {} }],
    };
    const result = sanitizeToolSchema(opaque);
    expect(result.default).toEqual({
      properties: {},
      required: ["should-not-be-pruned"],
    });
    expect(result.examples).toEqual([{ required: ["x"], properties: {} }]);
  });

  test("does not mutate its input, even when the output spine is mutated", () => {
    const input = {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a", "ghost"],
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    const result = sanitizeToolSchema(input);
    // Mutate the freshly-built output spine; the shared input must be intact.
    (result.required as string[]).push("mutated");
    (result.properties as Record<string, unknown>).b = { type: "number" };
    expect(input).toEqual(snapshot);
  });

  // --- Composition: `required` is pruned against each node's OWN direct
  // `properties` (Gemini does not resolve composition / parent scope, so a
  // single all-providers schema must conform to its stricter rule) ---------

  test("PRODUCTION REGRESSION: prunes a direct `required` whose property is only declared in a composition branch", () => {
    // The real GitHub MCP `issue_write` shape: `issue_fields.items` requires
    // `field_name`, but `field_name` is declared inside a `oneOf` branch, not
    // the item's own `properties`. Gemini rejects the whole request
    // ("property is not defined"); the sanitizer MUST strip it.
    const result = sanitizeToolSchema({
      type: "object",
      properties: {
        issue_fields: {
          type: "array",
          items: {
            type: "object",
            // No own `properties` — field_name lives in the oneOf branches.
            oneOf: [
              {
                properties: {
                  field_name: { type: "string" },
                  value: { type: "string" },
                },
              },
              {
                properties: {
                  field_name: { type: "string" },
                  delete: { type: "boolean" },
                },
              },
            ],
            required: ["field_name"],
          },
        },
      },
    });
    const items = obj(obj(obj(result.properties).issue_fields).items);
    expect(items.required).toBeUndefined(); // stripped → no Gemini 400
    // The oneOf structure itself is preserved untouched.
    expect((items.oneOf as unknown[]).length).toBe(2);
  });

  test("resolves an anyOf branch's required against branch + parent properties (transform #8)", () => {
    // Was "prunes a required in an anyOf branch against that branch's OWN
    // properties" — that name encoded the defect transform #8 fixes, so the
    // expectation was inverted rather than the coverage removed.
    //
    // `foo` lives on the PARENT, which is how JSON Schema composition works: an
    // `anyOf` branch is evaluated against the enclosing node. Pruning it (the
    // pre-transform-#8 behavior) silently deleted the constraint.
    const result = sanitizeToolSchema({
      type: "object",
      properties: {
        type: { type: "string", enum: ["A", "B"] },
        foo: { type: "string" },
      },
      anyOf: [
        {
          properties: { type: { const: "A" } },
          required: ["foo"],
        },
      ],
    });
    const branch = obj((result.anyOf as unknown[])[0]);
    expect(branch.required).toEqual(["foo"]);
    // The branch's `const` is preserved verbatim (Gemini supports it).
    expect(obj(obj(branch.properties).type).const).toBe("A");
    // …and, being a ROOT branch, it carries `foo`'s subschema down from the
    // parent so the branch stands on its own as an object schema.
    expect(obj(branch.properties).foo).toEqual({ type: "string" });
  });

  test("keeps a branch's required that references the branch's OWN property", () => {
    const result = sanitizeToolSchema({
      type: "object",
      anyOf: [
        {
          properties: { a: { type: "string" } },
          required: ["a"], // declared on the same node → kept
        },
      ],
    });
    expect(obj((result.anyOf as unknown[])[0]).required).toEqual(["a"]);
  });

  // --- Nested-scope recursion paths ---------------------------------------

  test("prunes a dangling required inside an object-valued additionalProperties", () => {
    const result = sanitizeToolSchema({
      type: "object",
      additionalProperties: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name", "ghost"],
      },
    });
    expect(obj(result.additionalProperties).required).toEqual(["name"]);
  });

  test("recurses through patternProperties", () => {
    const result = sanitizeToolSchema({
      type: "object",
      patternProperties: {
        "^x-": {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id", "ghost"],
        },
      },
    });
    expect(obj(obj(result.patternProperties)["^x-"]).required).toEqual(["id"]);
  });

  test("recurses through propertyNames", () => {
    const result = sanitizeToolSchema({
      type: "object",
      propertyNames: {
        type: "object",
        properties: { p: { type: "string" } },
        required: ["p", "ghost"],
      },
    });
    expect(obj(result.propertyNames).required).toEqual(["p"]);
  });

  test("recurses through prefixItems tuple elements", () => {
    const result = sanitizeToolSchema({
      type: "array",
      prefixItems: [
        {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a", "ghost"],
        },
      ],
    });
    expect(obj((result.prefixItems as unknown[])[0]).required).toEqual(["a"]);
  });

  test("dependentSchemas subschemas self-prune against their own properties", () => {
    const result = sanitizeToolSchema({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      dependentSchemas: {
        // `b` is a parent property, not declared on this subschema → stripped
        // (Gemini-conformant); `x` declared here → kept.
        a: { properties: { x: { type: "string" } }, required: ["b", "x"] },
      },
    });
    expect(obj(obj(result.dependentSchemas).a).required).toEqual(["x"]);
  });

  test("draft-07 dependencies: subschema form is sanitized, string[] form is opaque", () => {
    const result = sanitizeToolSchema({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      dependencies: {
        // subschema form — self-prunes: `b` (parent) stripped, `x` (own) kept
        a: { properties: { x: { type: "string" } }, required: ["b", "x"] },
        b: ["a"], // property-dependency form — opaque data, untouched
      },
    });
    const deps = obj(result.dependencies);
    expect(obj(deps.a).required).toEqual(["x"]);
    expect(deps.b).toEqual(["a"]);
  });

  // --- Robustness against adversarial / malformed input -------------------

  test("returns an empty object for a non-object root (boolean schema)", () => {
    expect(sanitizeToolSchema(true as unknown as Record<string, unknown>)).toEqual({});
    expect(sanitizeToolSchema(null as unknown as Record<string, unknown>)).toEqual({});
    expect(sanitizeToolSchema([] as unknown as Record<string, unknown>)).toEqual({});
  });

  test("does not overflow the stack on a pathologically deep schema", () => {
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 5000; i++) {
      deep = { type: "object", properties: { x: deep } };
    }
    expect(() => sanitizeToolSchema(deep)).not.toThrow();
  });

  test("does not overflow on a deep chain of nested ARRAYS", () => {
    // The object chain above reaches the guard through `sanitizeSchemaNode`; a
    // tuple-form `items` recurses through `sanitizeSubschema` without ever
    // touching it, which is how the bound was bypassable.
    let deep: unknown = { type: "string" };
    for (let i = 0; i < 5000; i++) deep = [deep];
    expect(() =>
      sanitizeToolSchema({ type: "array", items: deep as Record<string, unknown> }),
    ).not.toThrow();
  });

  test("does not hand a past-depth subtree back to the caller to serialize", () => {
    // Bounding only OUR recursion moves the overflow one frame out, to whoever
    // serializes the sanitized schema into the request body — further from
    // anyone who would recognize the cause.
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 20_000; i++) {
      deep = { type: "object", properties: { x: deep } };
    }
    const result = sanitizeToolSchema(deep);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  test("does not recurse into an enum member when describing a dropped enum", () => {
    // `type: "boolean"` forces the "Allowed values:" prose branch, which used
    // to hand each member to JSON.stringify — recursion the depth guard never
    // sees, since it bounds structural nesting only.
    let bomb: unknown = "leaf";
    for (let i = 0; i < 50_000; i++) bomb = [bomb];
    const result = sanitizeToolSchema({
      type: "object",
      properties: { x: { type: "boolean", enum: [bomb] } },
    });
    const x = (result.properties as Record<string, Record<string, unknown>>).x;
    expect(x!.description).toBe("Allowed values: […].");
    expect(x!.enum).toBeUndefined();
  });

  test("summarizes composite enum members but still renders scalars exactly", () => {
    const result = sanitizeToolSchema({
      type: "object",
      properties: {
        x: { type: "boolean", enum: [true, 1, "a", null, { k: 1 }, [1, 2]] },
      },
    });
    const x = (result.properties as Record<string, Record<string, unknown>>).x;
    expect(x!.description).toBe('Allowed values: true, 1, "a", null, {…}, […].');
  });

  test("a __proto__ keyword does not pollute Object.prototype", () => {
    const malicious = JSON.parse(
      '{"type":"object","__proto__":{"polluted":true}}',
    ) as Record<string, unknown>;
    const result = sanitizeToolSchema(malicious);
    expect(result.type).toBe("object");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("drops a non-array (malformed) required", () => {
    const result = sanitizeToolSchema({
      type: "object",
      properties: { a: { type: "string" } },
      required: 42 as unknown as string[],
    });
    expect("required" in result).toBe(false);
  });

  // --- Byte-stable golden output (provider prompt-cache contract) ----------

  test("golden: realistic issue_write-style schema sanitizes to a stable string", () => {
    // Locks the exact serialized output so a future key-reordering refactor
    // (which would silently bust provider prompt caches) fails loudly.
    const input = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        method: { const: "create" },
        title: { type: "string" },
        issue_fields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              value: { type: ["string", "number", "boolean"] },
              delete: { type: "boolean", enum: [true] },
            },
            required: ["name", "ghost"],
          },
        },
      },
      required: ["method", "phantom"],
    };
    const result = sanitizeToolSchema(input);
    expect(JSON.stringify(result)).toBe(
      '{"type":"object","properties":{"method":{"const":"create"},' +
        '"title":{"type":"string"},"issue_fields":{"type":"array","items":' +
        '{"type":"object","properties":{"name":{"type":"string"},"value":' +
        '{"type":"string","description":"Accepts string, number, or boolean."},' +
        '"delete":{"type":"boolean","description":"Allowed values: true."}},' +
        '"required":["name"]}}},"required":["method"]}',
    );
  });

  test("folds dropped constraints into `description` so the model still sees them", () => {
    // Dropped boolean enum → note appended to existing description.
    const delField = atProperty({
      type: "boolean",
      enum: [true],
      description: "Clear the field.",
    });
    expect(delField.description).toBe("Clear the field. Allowed values: true.");
    expect("enum" in delField).toBe(false);

    // Collapsed union type with NO existing description → a description is added.
    const valField = atProperty({ type: ["string", "number", "boolean"] });
    expect(valField.type).toBe("string");
    expect(valField.description).toBe("Accepts string, number, or boolean.");

    // Dropped number enum on a typeless node → original values surfaced.
    const n = atProperty({ enum: [1, 2, 3] });
    expect(n.description).toBe("Allowed values: 1, 2, 3.");

    // A kept string enum loses nothing → no note is manufactured.
    const ok = atProperty({ type: "string", enum: ["a", "b"], description: "Pick one." });
    expect(ok.description).toBe("Pick one.");

    // Partial filter: kept string members in the enum, dropped non-strings noted.
    const partial = atProperty({ type: "string", enum: ["a", 1, true] });
    expect(partial.enum).toEqual(["a"]);
    expect(partial.description).toBe("May also be 1 or true.");

    // A `["null"]`-only type is dropped but recorded.
    const nullOnly = atProperty({ type: ["null"] });
    expect("type" in nullOnly).toBe(false);
    expect(nullOnly.description).toBe("Must be null.");

    // Existing description is never lost — notes are appended to it.
    const both = atProperty({
      type: ["string", "number"],
      description: "The value.",
    });
    expect(both.description).toBe("The value. Accepts string or number.");
  });

  // --- Top-level `allOf` flatten: a Zod-intersection parameters root renders
  // as `{ allOf: [...] }` with no object root, which Grok (xAI) rejects with a
  // 502; flatten it into one object schema (transform #5) ------------------

  describe("flattens a top-level allOf into a single object root", () => {
    test("merges properties + required from a Zod-intersection root (the Grok 502 case)", () => {
      const result = sanitizeToolSchema({
        description: "Convert an Excel file.",
        allOf: [
          {
            type: "object",
            properties: {
              attachmentId: { type: "string" },
              url: { type: "string", format: "uri" },
            },
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              format: { type: "string", enum: ["markdown", "csv"] },
            },
            required: ["format"],
            additionalProperties: false,
          },
        ],
      });
      expect(result.type).toBe("object");
      expect("allOf" in result).toBe(false);
      expect(Object.keys(obj(result.properties)).sort()).toEqual([
        "attachmentId",
        "format",
        "url",
      ]);
      expect(result.required).toEqual(["format"]);
      // transform #6 dropped each branch's `additionalProperties: false` before
      // the flatten, so the merged root carries none.
      expect("additionalProperties" in result).toBe(false);
      // Root-level annotations survive the flatten.
      expect(result.description).toBe("Convert an Excel file.");
      // Branch subschemas are still sanitized: the string enum is preserved.
      expect(obj(obj(result.properties).format).enum).toEqual([
        "markdown",
        "csv",
      ]);
    });

    test("prunes a unioned required that no branch actually declares", () => {
      const result = sanitizeToolSchema({
        allOf: [
          { type: "object", properties: { a: { type: "string" } } },
          {
            type: "object",
            properties: { b: { type: "string" } },
            required: ["b", "ghost"],
          },
        ],
      });
      expect(result.required).toEqual(["b"]);
    });

    test("leaves a top-level anyOf/oneOf root untouched", () => {
      const anyOf = sanitizeToolSchema({
        anyOf: [{ type: "object", properties: { a: { type: "string" } } }],
      });
      expect("anyOf" in anyOf).toBe(true);
      expect("type" in anyOf).toBe(false);
    });

    test("does NOT flatten when a branch carries a $ref (would drop the constraint)", () => {
      // The common MCP shape `{ allOf: [{ $ref: "#/$defs/Input" }] }`: the merge
      // can't carry the $ref forward, so the allOf must be preserved verbatim
      // rather than collapsed to an empty object.
      const input = {
        allOf: [{ $ref: "#/$defs/Input" }],
        $defs: { Input: { type: "object", properties: { a: { type: "string" } } } },
      };
      const result = sanitizeToolSchema(input);
      expect(Array.isArray(result.allOf)).toBe(true);
      expect(obj((result.allOf as unknown[])[0]).$ref).toBe("#/$defs/Input");
      // The root was NOT rewritten into a bare `{ type: "object", properties: {} }`.
      expect(result.properties).toBeUndefined();
    });

    test("does NOT flatten when a branch carries not/if (non-mergeable keywords)", () => {
      const withNot = sanitizeToolSchema({
        allOf: [
          { type: "object", properties: { a: { type: "string" } } },
          { not: { required: ["a"] } },
        ],
      });
      expect(Array.isArray(withNot.allOf)).toBe(true);

      const withIf = sanitizeToolSchema({
        allOf: [
          { type: "object", properties: { a: { type: "string" } } },
          { if: { properties: { a: {} } }, then: { required: ["a"] } },
        ],
      });
      expect(Array.isArray(withIf.allOf)).toBe(true);
    });

    test("does NOT flatten a nested allOf or a non-object-typed branch", () => {
      const nested = sanitizeToolSchema({
        allOf: [
          { type: "object", properties: { a: { type: "string" } } },
          { allOf: [{ type: "object", properties: { b: { type: "string" } } }] },
        ],
      });
      expect(Array.isArray(nested.allOf)).toBe(true);

      const nonObject = sanitizeToolSchema({
        allOf: [{ type: "string" }, { type: "object", properties: { a: {} } }],
      });
      expect(Array.isArray(nonObject.allOf)).toBe(true);
    });

    test("does NOT flatten when a branch has a schema-valued additionalProperties", () => {
      const result = sanitizeToolSchema({
        allOf: [
          { type: "object", properties: { a: { type: "string" } } },
          { type: "object", additionalProperties: { type: "number" } },
        ],
      });
      expect(Array.isArray(result.allOf)).toBe(true);
    });

    test("folds branch-level descriptions into the merged description", () => {
      const result = sanitizeToolSchema({
        description: "Root doc.",
        allOf: [
          {
            type: "object",
            properties: { a: { type: "string" } },
            description: "Input payload.",
          },
          { type: "object", properties: { b: { type: "string" } } },
        ],
      });
      expect(result.description).toBe("Root doc. Input payload.");
      expect(Object.keys(obj(result.properties)).sort()).toEqual(["a", "b"]);
    });

    test("drops a branch's additionalProperties: false but carries a true (transform #6)", () => {
      // The node walk strips `false` from each branch before the flatten, so the
      // merged root never carries `false`; a `true` (no-op default) is carried.
      const result = sanitizeToolSchema({
        allOf: [
          { type: "object", properties: { a: { type: "string" } }, additionalProperties: true },
          { type: "object", properties: { b: { type: "string" } }, additionalProperties: false },
        ],
      });
      expect(result.additionalProperties).toBe(true);
    });

    test("flattens a branch that has only additionalProperties (no properties)", () => {
      const result = sanitizeToolSchema({
        allOf: [
          { type: "object", properties: { a: { type: "string" } } },
          { type: "object", additionalProperties: false },
        ],
      });
      expect(Object.keys(obj(result.properties))).toEqual(["a"]);
      // The lone `additionalProperties: false` was dropped (transform #6).
      expect("additionalProperties" in result).toBe(false);
    });

    test("prunes a required entry named after a prototype member (hasOwnProperty, not `in`)", () => {
      // `"toString" in mergedProps` is true via the prototype chain; the merged
      // result must NOT emit a required pointing at an undeclared property.
      const result = sanitizeToolSchema({
        allOf: [
          { type: "object", properties: { a: { type: "string" } }, required: ["a", "toString"] },
        ],
      });
      expect(result.required).toEqual(["a"]);
    });

    test("an empty allOf is dropped before the flatten ever sees it", () => {
      // Was "an empty allOf flattens to a bare object". Transform #10 now strips
      // an empty array-valued keyword at every node, because xAI rejects one at
      // any depth (`[] has less than 1 item`) — so the flatten no longer has an
      // `allOf` to merge here. The emitted `{}` is the unconstrained root, which
      // is accepted 9/9; an `allOf` of nothing constrained nothing either.
      const result = sanitizeToolSchema({ allOf: [] });
      expect(result).toEqual({});
      expect("allOf" in result).toBe(false);
    });

    test("an empty composition is dropped at every depth (transform #10)", () => {
      // Measured on grok-4.5: `/properties/a/oneOf: [] has less than 1 item`,
      // and the same for `anyOf`, `allOf` and `prefixItems`. Empty OBJECTS and
      // an empty `required: []` are accepted, so they are left alone.
      const result = sanitizeToolSchema({
        type: "object",
        properties: {
          a: { oneOf: [] },
          b: { anyOf: [] },
          c: { allOf: [] },
          d: { type: "array", prefixItems: [] },
          e: { type: "object", properties: {}, required: [] },
        },
      });
      const props = obj(result.properties);
      expect(obj(props.a)).toEqual({});
      expect(obj(props.b)).toEqual({});
      expect(obj(props.c)).toEqual({});
      expect(obj(props.d)).toEqual({ type: "array" });
      // Empty object-valued keywords are accepted by every model, so untouched.
      expect(obj(props.e)).toEqual({ type: "object", properties: {} });
    });
  });

  describe("composition-branch required + root usability (transforms #8/#9)", () => {
    /** The production shape: "pass exactly one of these", written the ordinary
     * way — properties on the parent, only `required` in each branch. */
    const exactlyOneOf = (keyword: "oneOf" | "anyOf" | "allOf") => ({
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search." },
        memoryItemId: { type: "string" },
      },
      [keyword]: [{ required: ["query"] }, { required: ["memoryItemId"] }],
    });

    test("the headline case emits self-sufficient object branches, not [{}, {}]", () => {
      const result = sanitizeToolSchema(exactlyOneOf("oneOf"));
      expect(result.oneOf).toEqual([
        {
          type: "object",
          required: ["query"],
          properties: { query: { type: "string", description: "Free-text search." } },
        },
        {
          type: "object",
          required: ["memoryItemId"],
          properties: { memoryItemId: { type: "string" } },
        },
      ]);
      // The parent keeps its full property set; only the branches are narrowed.
      expect(Object.keys(obj(result.properties)).sort()).toEqual([
        "memoryItemId",
        "query",
      ]);
    });

    test("same for anyOf", () => {
      const result = sanitizeToolSchema(exactlyOneOf("anyOf"));
      const branches = result.anyOf as Record<string, unknown>[];
      expect(branches.map((b) => b.required)).toEqual([
        ["query"],
        ["memoryItemId"],
      ]);
      // Every branch is object-carrying — the xAI root-union invariant.
      expect(branches.every((b) => b.type === "object")).toBe(true);
      expect(branches.map((b) => Object.keys(obj(b.properties)))).toEqual([
        ["query"],
        ["memoryItemId"],
      ]);
    });

    test("same for allOf — repaired branches, then merged by transform #5", () => {
      // A root `allOf` of object branches flattens (transform #5), so the
      // repaired branches surface as a unioned root `required` rather than as
      // surviving branches. That is exactly equivalent for an intersection —
      // `allOf` means satisfy every branch — and it is the constraint that was
      // being lost before transform #8.
      const result = sanitizeToolSchema(exactlyOneOf("allOf"));
      expect("allOf" in result).toBe(false);
      expect(result.required).toEqual(["query", "memoryItemId"]);
      expect(Object.keys(obj(result.properties)).sort()).toEqual([
        "memoryItemId",
        "query",
      ]);
    });

    test("repairs a branch when oneOf precedes properties in key order", () => {
      // The parent's `properties` is sanitized ahead of the key walk precisely
      // so the outcome does not depend on which keyword the walk reaches first.
      const result = sanitizeToolSchema({
        oneOf: [{ required: ["a"] }, { required: ["b"] }],
        properties: { a: { type: "string" }, b: { type: "number" } },
        type: "object",
      });
      const branches = result.oneOf as Record<string, unknown>[];
      expect(branches.map((b) => b.required)).toEqual([["a"], ["b"]]);
      expect(obj(branches[0]!.properties).a).toEqual({ type: "string" });
      expect(obj(branches[1]!.properties).b).toEqual({ type: "number" });
      expect(sanitizeToolSchema(result)).toEqual(result);
    });

    test("a branch's OWN property declaration wins over the parent's", () => {
      const result = sanitizeToolSchema({
        type: "object",
        properties: { mode: { type: "string" } },
        oneOf: [
          {
            properties: { mode: { type: "string", const: "fast" } },
            required: ["mode"],
          },
        ],
      });
      const branch = obj((result.oneOf as unknown[])[0]);
      expect(obj(branch.properties).mode).toEqual({
        type: "string",
        const: "fast",
      });
    });

    test("copies down only the names in the branch's own required", () => {
      const result = sanitizeToolSchema({
        type: "object",
        properties: {
          a: { type: "string" },
          b: { type: "string" },
          c: { type: "string" },
        },
        oneOf: [{ required: ["a"] }, { required: ["b"] }],
      });
      const branches = result.oneOf as Record<string, unknown>[];
      expect(branches.map((b) => Object.keys(obj(b.properties)))).toEqual([
        ["a"],
        ["b"],
      ]);
    });

    test("copies down the SANITIZED parent subschema, not the raw one", () => {
      // `v`'s union `type` is collapsed by transform #1 before the copy-down, so
      // the branch never carries a construct Gemini rejects — and a second pass
      // has nothing left to collapse (see the idempotence table below).
      const result = sanitizeToolSchema({
        type: "object",
        properties: { v: { type: ["string", "number"] } },
        oneOf: [{ required: ["v"] }],
      });
      const branch = obj((result.oneOf as unknown[])[0]);
      expect(obj(branch.properties).v).toEqual({
        type: "string",
        description: "Accepts string or number.",
      });
    });

    test("a root branch naming something absent everywhere drops the keyword", () => {
      const result = sanitizeToolSchema({
        type: "object",
        properties: { a: { type: "string" } },
        oneOf: [{ required: ["a"] }, { required: ["zzz"] }],
      });
      // `zzz` is on no `properties` map, so that branch empties out and cannot
      // be repaired; the whole `oneOf` goes rather than emitting `[…, {}]`,
      // which xAI 400s for every tool in the request.
      expect("oneOf" in result).toBe(false);
      expect(result.type).toBe("object");
      expect(Object.keys(obj(result.properties))).toEqual(["a"]);
    });

    test("a branch requiring an additionalProperties-only name drops the keyword", () => {
      // The parent supplies `x` through `additionalProperties`, not through
      // `properties`, so the branch cannot be made self-sufficient (transform
      // #8's copy-down has nothing to copy) and falls through to #9.
      const result = sanitizeToolSchema({
        type: "object",
        properties: { a: { type: "string" } },
        additionalProperties: { type: "string" },
        anyOf: [{ required: ["a"] }, { required: ["x"] }],
      });
      expect("anyOf" in result).toBe(false);
      expect(result.additionalProperties).toEqual({ type: "string" });
    });

    test("a root union with a non-object branch drops the keyword", () => {
      // Measured: an object root does NOT excuse a non-object branch — Grok
      // 400s `{type:"object", properties:…, oneOf:[{type:"object",…},
      // {type:"string"}]}` on all of 4.3/4.5/4.6.
      const result = sanitizeToolSchema({
        type: "object",
        properties: { a: { type: "string" } },
        oneOf: [
          { type: "object", properties: { a: { type: "string" } } },
          { type: "string" },
        ],
      });
      expect("oneOf" in result).toBe(false);
    });

    test("a contradictory branch is REPAIRED, not dropped (transforms #12 + #9)", () => {
      // Was "a root union branch with a non-object type is dropped even with
      // properties". `{type:"string", properties:{…}, required:[…]}` as a root
      // union branch is 0/3 on grok-4.3/4.5/4.6 as written, so the branch rule
      // still disqualifies a NON-object type — but transform #12 now retypes any
      // node carrying `properties` to `object` (Gemini rejects the contradictory
      // form outright) BEFORE that check runs. So the branch arrives usable and
      // the constraint survives instead of the whole keyword being discarded,
      // and the emitted branch is the measured-good `{type:"object", properties,
      // required}` shape. A branch with a non-object type and NO properties is
      // still unrepairable and still drops the keyword — covered below.
      const result = sanitizeToolSchema({
        type: "object",
        properties: { a: { type: "string" } },
        oneOf: [
          { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
          { type: "string", properties: { a: { type: "string" } }, required: ["a"] },
        ],
      });
      const branches = result.oneOf as Record<string, unknown>[];
      expect(branches).toHaveLength(2);
      expect(branches[1]!.type).toBe("object");
      expect(branches[1]!.required).toEqual(["a"]);
      expect(branches[1]!.description).toBe(
        "Declared as string, but carries properties, so it is treated as an object.",
      );
    });

    test("a non-object branch with NO properties still drops the keyword", () => {
      // Nothing for transform #12 to work with, so the branch stays unusable.
      const result = sanitizeToolSchema({
        type: "object",
        properties: { a: { type: "string" } },
        oneOf: [
          { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
          { type: "string" },
        ],
      });
      expect("oneOf" in result).toBe(false);
    });

    test("a typeless branch carrying properties is still usable", () => {
      const result = sanitizeToolSchema({
        type: "object",
        properties: { a: { type: "string" } },
        oneOf: [
          { properties: { a: { type: "string" } }, required: ["a"] },
          { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        ],
      });
      // The keyword survives — a typeless branch carrying `properties` is
      // usable. Transform #12 then supplies the `type: "object"` that
      // `properties` already implies, which Gemini requires explicitly.
      expect(result.oneOf).toEqual([
        { properties: { a: { type: "string" } }, required: ["a"], type: "object" },
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      ]);
    });

    test("drops an unusable root union BEFORE flattening a mergeable allOf", () => {
      // Both keywords on one root: `canLosslesslyFlattenAllOf` refuses to merge
      // while a union sibling is present, so dropping the union afterwards would
      // leave an `allOf` for the NEXT pass to flatten — an idempotence break.
      // Rule (a) runs first, which makes the root a genuine intersection.
      const result = sanitizeToolSchema({
        type: "object",
        properties: { a: {} },
        allOf: [{ type: "object", properties: { b: {} } }],
        oneOf: [{ type: "string" }],
      });
      expect("oneOf" in result).toBe(false);
      expect("allOf" in result).toBe(false);
      expect(Object.keys(obj(result.properties)).sort()).toEqual(["a", "b"]);
    });

    test("one unusable branch drops the keyword, repaired siblings included", () => {
      // All-or-nothing on purpose. A single bad branch poisons the whole union
      // on xAI (0/3 with a `{type:"string"}` sibling beside a valid object
      // branch), so a mixed union cannot be left alone. Filtering the bad arm
      // out is accepted by xAI (3/3) but advertises a narrower tool — the model
      // would be told the dropped arm is invalid and never call that shape.
      // Dropping the keyword keeps the parent's properties visible, so every
      // shape stays callable and a bad COMBINATION surfaces at dispatch.
      const result = sanitizeToolSchema({
        type: "object",
        properties: { query: { type: "string" }, memoryItemId: { type: "string" } },
        oneOf: [{ required: ["query"] }, { required: ["zzz"] }],
      });
      expect("oneOf" in result).toBe(false);
      // Both parameters remain callable — nothing was removed from the model's view.
      expect(Object.keys(obj(result.properties)).sort()).toEqual([
        "memoryItemId",
        "query",
      ]);
    });

    describe("a root union branch carrying its OWN union", () => {
      const S = { type: "string" };

      test("drops the keyword and keeps the rest of the root", () => {
        // Measured 0/3 on grok-4.3/4.5/4.6 (9/9 on Gemini and GPT): a branch
        // that declares `type: "object"` but carries its own `anyOf` still
        // fails the root-must-be-an-object check, and the 400 takes every tool
        // in the request with it. The `type` is not the problem — the branch's
        // own union is.
        const result = sanitizeToolSchema({
          type: "object",
          properties: { a: S, b: S },
          oneOf: [
            {
              type: "object",
              anyOf: [{ properties: { a: S } }, { properties: { b: S } }],
            },
            { type: "object", properties: { b: S } },
          ],
        });
        expect("oneOf" in result).toBe(false);
        expect(result.type).toBe("object");
        expect(Object.keys(obj(result.properties)).sort()).toEqual(["a", "b"]);
      });

      test("same for an anyOf root", () => {
        const result = sanitizeToolSchema({
          type: "object",
          properties: { a: S, b: S },
          anyOf: [
            { type: "object", oneOf: [{ properties: { a: S } }] },
            { type: "object", properties: { b: S } },
          ],
        });
        expect("anyOf" in result).toBe(false);
        expect(Object.keys(obj(result.properties)).sort()).toEqual(["a", "b"]);
      });

      test("a branch's own allOf is NOT a disqualifier", () => {
        // `ROOT_UNION_KEYS`, not `COMPOSITION_KEYS`. A branch carrying its own
        // `allOf` is accepted 9/9 — including with a bare-`required` sub-branch
        // — which is the same intersection-vs-union asymmetry xAI applies to
        // the root itself. Disqualifying it would destroy a constraint every
        // provider honours.
        const result = sanitizeToolSchema({
          type: "object",
          properties: { a: S, b: S },
          oneOf: [
            { type: "object", allOf: [{ properties: { a: S } }] },
            { type: "object", properties: { b: S } },
          ],
        });
        // Kept, not dropped — only the branch's own `anyOf`/`oneOf` disqualifies.
        expect(result.oneOf).toEqual([
          { type: "object", allOf: [{ properties: { a: S }, type: "object" }] },
          { type: "object", properties: { b: S } },
        ]);
      });

      test("a branch carrying BOTH allOf and anyOf is disqualified by the anyOf", () => {
        // Measured 0/3 — the union poisons it even alongside an allOf.
        const result = sanitizeToolSchema({
          type: "object",
          properties: { a: S, b: S },
          oneOf: [
            {
              type: "object",
              allOf: [{ properties: { a: S } }],
              anyOf: [{ properties: { b: S } }],
            },
            { type: "object", properties: { b: S } },
          ],
        });
        expect("oneOf" in result).toBe(false);
      });

      test("OVER-REACH GUARD: a composition on a branch's PROPERTY survives", () => {
        // The disqualifier is the branch's OWN keys, never its subtree. A
        // composition on a branch's property is accepted 9/9, as is one two
        // levels down, so a subtree scan would silently destroy legitimate
        // constraints. This is the test most likely to catch a wrong fix.
        const result = sanitizeToolSchema({
          type: "object",
          properties: { a: S, b: S },
          oneOf: [
            {
              type: "object",
              properties: {
                a: { anyOf: [{ properties: { x: S } }, { properties: { y: S } }] },
              },
            },
            { type: "object", properties: { b: S } },
          ],
        });
        // The keyword survives, and so does the composition on the branch's
        // property — that is the whole point of the guard.
        const branches = result.oneOf as Record<string, unknown>[];
        expect(branches).toHaveLength(2);
        expect(obj(obj(branches[0]!.properties).a).anyOf).toEqual([
          { properties: { x: S }, type: "object" },
          { properties: { y: S }, type: "object" },
        ]);
      });

      test("OVER-REACH GUARD: a composition two levels under a branch survives", () => {
        const result = sanitizeToolSchema({
          type: "object",
          properties: { a: S, b: S },
          oneOf: [
            {
              type: "object",
              properties: {
                a: { properties: { inner: { anyOf: [{ properties: { x: S } }] } } },
              },
            },
            { type: "object", properties: { b: S } },
          ],
        });
        const branches = result.oneOf as Record<string, unknown>[];
        expect(branches).toHaveLength(2);
        const inner = obj(obj(obj(obj(branches[0]!.properties).a).properties).inner);
        expect(inner.anyOf).toEqual([{ properties: { x: S }, type: "object" }]);
      });

      test("a NESTED union with a composition branch is untouched", () => {
        // Root-only, like every other part of transform #9.
        const result = sanitizeToolSchema({
          type: "object",
          properties: {
            w: {
              type: "object",
              properties: { a: S, b: S },
              oneOf: [{ type: "object", anyOf: [{ properties: { a: S } }] }],
            },
          },
        });
        // Root-only: the nested union keeps its composition branch, which rule
        // (a) would have dropped at the root.
        const w = obj(obj(result.properties).w);
        expect(w.oneOf).toEqual([
          { type: "object", anyOf: [{ properties: { a: S }, type: "object" }] },
        ]);
      });
    });

    test("a root union branch that is itself a composition drops the keyword", () => {
      // Known loss, measured: `{oneOf:[{anyOf:[{type:"object",…},…]}]}` is 0/3 on
      // Grok even with `type: "object"` stamped on the root, so counting the
      // branch usable because ITS elements are object-shaped would reintroduce
      // the 400. The result is `{}` — accepted everywhere, advertises nothing.
      const result = sanitizeToolSchema({
        oneOf: [
          {
            anyOf: [
              { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
              { type: "object", properties: { b: { type: "string" } }, required: ["b"] },
            ],
          },
        ],
      });
      expect(result).toEqual({});
    });

    test("a bare union root whose branches are all objects is left alone", () => {
      const input = {
        oneOf: [
          { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
          { type: "object", properties: { b: { type: "string" } }, required: ["b"] },
        ],
      };
      // Measured 9/9 as-is (xAI infers the root's object-ness from the
      // branches), so transform #9 adds nothing.
      expect(sanitizeToolSchema(input)).toEqual(input);
    });

    test("an un-flattenable root allOf is rescued with type: object, not dropped", () => {
      // `{allOf:[{$ref:…}]}` is 0/3 on Grok today — the root is not an object
      // type. Transform #9 adds `type: "object"` (9/9) instead of discarding the
      // `allOf`, so the constraint transform #5 declines to merge survives.
      const result = sanitizeToolSchema({
        allOf: [{ $ref: "#/$defs/Input" }],
        $defs: { Input: { type: "object", properties: { a: { type: "string" } } } },
      });
      expect(result.type).toBe("object");
      expect(obj((result.allOf as unknown[])[0]).$ref).toBe("#/$defs/Input");
      expect(result.$defs).toBeDefined();
      expect("properties" in result).toBe(false);
    });

    test("a root allOf's branches are NOT held to the union branch rule", () => {
      // Measured: xAI accepts `$ref` / `not` / nested-`allOf` / scalar branches
      // under a root `allOf` as long as the root itself is an object type — so
      // rule (a) covers `anyOf`/`oneOf` only, and an identical branch that would
      // drop a `oneOf` leaves an `allOf` standing.
      const result = sanitizeToolSchema({
        type: "object",
        properties: { a: { type: "string" } },
        allOf: [{ $ref: "#/$defs/Extra" }],
        $defs: { Extra: { type: "object", properties: { b: { type: "string" } } } },
      });
      expect(result.allOf).toEqual([{ $ref: "#/$defs/Extra" }]);

      // The same `$ref` under a `oneOf` is not usable as written — but
      // transform #14 inlines it rather than dropping the keyword, so the
      // constraint survives as an ordinary object branch.
      const asUnion = sanitizeToolSchema({
        type: "object",
        properties: { a: { type: "string" } },
        oneOf: [{ $ref: "#/$defs/Extra" }],
        $defs: { Extra: { type: "object", properties: { b: { type: "string" } } } },
      });
      expect(asUnion.oneOf).toEqual([
        { type: "object", properties: { b: { type: "string" } } },
      ]);
    });

    test("a zod-style union root of $refs is inlined, keeping the constraint", () => {
      // `z.union([A, B])` renders as `{anyOf:[{$ref:…},{$ref:…}], $defs:…}`, and
      // xAI does not resolve a `$ref` union branch — 0/3 even with
      // `type: "object"` on the root. This used to drop the keyword, which for
      // a root whose properties live entirely in `$defs` left the tool
      // advertising NO parameters. Transform #14 inlines the targets instead,
      // producing the ordinary object branches that measure 9/9.
      const result = sanitizeToolSchema({
        anyOf: [{ $ref: "#/$defs/A" }, { $ref: "#/$defs/B" }],
        $defs: {
          A: { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
          B: { type: "object", properties: { b: { type: "string" } }, required: ["b"] },
        },
      });
      expect(result.anyOf).toEqual([
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { type: "object", properties: { b: { type: "string" } }, required: ["b"] },
      ]);
      // The root needs no `type` stamp: xAI infers object-ness from a union
      // whose branches are all object-shaped.
      expect("type" in result).toBe(false);
      expect(Object.keys(obj(result.$defs)).sort()).toEqual(["A", "B"]);
    });

    test("bounds inlining by EXPANDED size, not the target's key count", () => {
      // A `$defs` target of `{type, properties}` has two top-level keys however
      // large `properties` is, so a key-count budget let 256 branches each
      // duplicate it — measured, a 0.11 MB schema became a 26 MB request body
      // (242x). The budget prices the whole subtree, so the union is dropped
      // rather than inlined at this scale.
      const properties: Record<string, unknown> = {};
      for (let i = 0; i < 400; i++) properties[`p${i}`] = { type: "string" };
      const input = {
        anyOf: Array.from({ length: 64 }, () => ({ $ref: "#/$defs/Big" })),
        $defs: { Big: { type: "object", properties } },
      };
      const result = sanitizeToolSchema(input);
      expect("anyOf" in result).toBe(false);
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(
        JSON.stringify(input).length,
      );
    });

    test("a small target IS inlined — the bound does not disable the transform", () => {
      const result = sanitizeToolSchema({
        anyOf: Array.from({ length: 4 }, () => ({ $ref: "#/$defs/Small" })),
        $defs: { Small: { type: "object", properties: { a: { type: "string" } } } },
      });
      expect((result.anyOf as unknown[]).length).toBe(4);
      expect(JSON.stringify(result.anyOf)).not.toContain("$ref");
    });

    test("an un-inlinable $ref branch still drops the keyword", () => {
      // Nothing to inline: the target is not a plain object schema, so the
      // branch stays unusable and rule (a) applies as before.
      const result = sanitizeToolSchema({
        type: "object",
        properties: { a: { type: "string" } },
        anyOf: [{ $ref: "#/$defs/Scalar" }],
        $defs: { Scalar: true },
      });
      expect("anyOf" in result).toBe(false);
    });

    test("rewrites a non-object root type to object, recording the original", () => {
      // Was "does not override a type the root declared for itself". A property
      // sweep over recursive shapes found that the deferential version emits a
      // root every Grok rejects, and gpt-5.6-sol too; a root whose `type`
      // contradicts its `properties` is rejected by all nine. Function-call
      // arguments are always a named object on the wire, so a scalar parameters
      // root cannot describe a callable tool for ANY provider — rewriting it is
      // the repair, and `{type:"object", …}` is accepted 9/9.
      const result = sanitizeToolSchema({
        type: "string",
        allOf: [{ type: "string", minLength: 1 }],
      });
      expect(result.type).toBe("object");
      expect(result.description).toBe(
        "Declared as string at the schema root; arguments are passed as an object.",
      );
      // The composition it carried is untouched by the retype.
      expect(Array.isArray(result.allOf)).toBe(true);
    });

    describe("nested compositions", () => {
      test("keep their required and are otherwise passed through unchanged", () => {
        // Measured: the identical bare-`required` union nested under a property
        // is accepted by all nine models, Grok included — so the branch keeps
        // its constraint and is NOT ballooned with a copy-down.
        const input = {
          type: "object",
          properties: {
            filter: {
              type: "object",
              properties: {
                query: { type: "string" },
                memoryItemId: { type: "string" },
              },
              oneOf: [{ required: ["query"] }, { required: ["memoryItemId"] }],
            },
          },
        };
        expect(sanitizeToolSchema(input)).toEqual(input);
      });

      test("an unrepairable nested branch keeps its (pruned) shape, not dropped", () => {
        // Transform #9 is root-only: a nested `oneOf` containing an emptied
        // branch is left in place, because no provider rejects it.
        const result = sanitizeToolSchema({
          type: "object",
          properties: {
            filter: {
              type: "object",
              properties: { a: { type: "string" } },
              oneOf: [{ required: ["a"] }, { required: ["zzz"] }],
            },
          },
        });
        const filter = obj(obj(result.properties).filter);
        expect(filter.oneOf).toEqual([{ required: ["a"] }, {}]);
      });
    });

    describe("regressions the parent scope must not widen into", () => {
      test("a nested node's required naming an ANCESTOR-only property is still pruned", () => {
        // The Gemini 400 transform #3 exists to prevent. `child` is a plain
        // property subschema, NOT a composition branch, so it gets no parent
        // scope — widening this is measured at 0/9 on Gemini.
        const result = sanitizeToolSchema({
          type: "object",
          properties: {
            a: { type: "string" },
            child: { type: "object", required: ["a"] },
          },
        });
        expect(obj(obj(result.properties).child).required).toBeUndefined();
      });

      test("a composition branch gets the ENCLOSING node only, not grandparents", () => {
        const result = sanitizeToolSchema({
          type: "object",
          properties: {
            grandparentOnly: { type: "string" },
            child: {
              type: "object",
              properties: { own: { type: "string" } },
              oneOf: [{ required: ["own", "grandparentOnly"] }],
            },
          },
        });
        const branch = obj(
          (obj(obj(result.properties).child).oneOf as unknown[])[0],
        );
        expect(branch.required).toEqual(["own"]);
      });

      test("`if`/`then` and dependentSchemas are not composition arrays", () => {
        const result = sanitizeToolSchema({
          type: "object",
          properties: { a: { type: "string" } },
          if: { required: ["a"] },
          then: { required: ["a"] },
        });
        // Not `allOf`/`anyOf`/`oneOf` elements, so transform #3 applies to them
        // unchanged — no parent scope, `required` pruned.
        expect(obj(result.if).required).toBeUndefined();
        expect(obj(result.then).required).toBeUndefined();
      });

      test("prefixItems elements are item schemas, not composition branches", () => {
        const result = sanitizeToolSchema({
          type: "object",
          properties: { a: { type: "string" } },
          prefixItems: [{ type: "object", required: ["a"] }],
        });
        expect(obj((result.prefixItems as unknown[])[0]).required).toBeUndefined();
      });
    });

    test("stays linear in properties × branches", () => {
      // The parent's property names are probed against the map directly rather
      // than unioned into a per-branch `Set`. Both counts are attacker-
      // controlled for a third-party MCP `rawJsonSchema`, so the quadratic form
      // is a denial of service for every tenant on the process: at N = 3000 it
      // measured ~1.1s of synchronously blocked event loop, versus ~20ms here.
      // The bound is deliberately loose — this catches a return to O(N²), not a
      // constant-factor regression.
      const N = 3000;
      const properties: Record<string, unknown> = {};
      for (let i = 0; i < N; i++) properties[`p${i}`] = { type: "string" };
      const oneOf = Array.from({ length: N }, (_, i) => ({ required: [`p${i}`] }));

      const started = performance.now();
      const result = sanitizeToolSchema({ type: "object", properties, oneOf });
      const elapsedMs = performance.now() - started;

      // At this size the copy-down ceiling is blown, so rule (a) drops the
      // keyword — the point here is that we reach that verdict in linear time
      // rather than grinding through N × P set insertions to get there.
      expect("oneOf" in result).toBe(false);
      expect(Object.keys(obj(result.properties)).length).toBe(N);
      expect(elapsedMs).toBeLessThan(600);
    });

    test("bounds the total copy-down across a root composition", () => {
      // The per-branch bound (a branch's own `required`) does not bound the
      // total: N branches × P required names copies N × P subschemas out of an
      // O(N + P) input. Measured at N=2000, P=100 that turned a 1.2 MB schema
      // into a 17.5 MB request body — paid on every model call, from a
      // third-party MCP schema. Past the ceiling the repair is skipped and the
      // branches stay bare, so rule (a) drops the keyword.
      const build = (branches: number, namesPerBranch: number) => {
        const properties: Record<string, unknown> = {};
        const names: string[] = [];
        for (let i = 0; i < namesPerBranch; i++) {
          names.push(`p${i}`);
          properties[`p${i}`] = { type: "string" };
        }
        return {
          type: "object",
          properties,
          oneOf: Array.from({ length: branches }, () => ({ required: [...names] })),
        };
      };

      // 8 × 4 = 32 copies — comfortably inside the ceiling, so it is repaired.
      const withinBudget = sanitizeToolSchema(build(8, 4));
      const branches = withinBudget.oneOf as Record<string, unknown>[];
      expect(branches).toHaveLength(8);
      expect(branches.every((b) => Object.keys(obj(b.properties)).length === 4)).toBe(true);

      // 200 × 100 = 20,000 copies — over the ceiling, so the keyword goes.
      const overBudget = sanitizeToolSchema(build(200, 100));
      expect("oneOf" in overBudget).toBe(false);
      // The root itself is untouched and still usable.
      expect(overBudget.type).toBe("object");
      expect(Object.keys(obj(overBudget.properties)).length).toBe(100);
    });

    test("does not repair a branch that declares a non-object type", () => {
      // `required`/`properties` are object-only keywords, so copying properties
      // into a `type: "string"` branch would emit a self-contradictory — and
      // unmeasured — schema. It is left alone and rule (a) drops the keyword.
      const result = sanitizeToolSchema({
        type: "object",
        properties: { foo: { type: "string" } },
        oneOf: [
          { type: "object", properties: { foo: { type: "string" } }, required: ["foo"] },
          { type: "string", required: ["foo"] },
        ],
      });
      expect("oneOf" in result).toBe(false);
    });

    test("does not mutate the input object", () => {
      const input = {
        type: "object",
        properties: {
          query: { type: ["string", "number"] },
          memoryItemId: { type: "string" },
        },
        oneOf: [{ required: ["query"] }, { required: ["memoryItemId"] }],
      };
      const before = structuredClone(input);
      sanitizeToolSchema(input);
      expect(input).toEqual(before);
    });

    describe("idempotence", () => {
      // Transform #8's copy-down is worthless if a second pass re-empties the
      // branch, so every fixture must be a fixed point after one pass.
      const fixtures: Record<string, Record<string, unknown>> = {
        "headline oneOf": exactlyOneOf("oneOf"),
        "headline anyOf": exactlyOneOf("anyOf"),
        "headline allOf": exactlyOneOf("allOf"),
        "branch overriding a parent property": {
          type: "object",
          properties: { mode: { type: "string" } },
          oneOf: [
            { properties: { mode: { const: "fast" } }, required: ["mode"] },
          ],
        },
        "copy-down of a collapsed union type": {
          type: "object",
          properties: { v: { type: ["string", "number"] } },
          oneOf: [{ required: ["v"] }],
        },
        "copy-down of a dropped enum": {
          type: "object",
          properties: { flag: { type: "boolean", enum: [true] } },
          anyOf: [{ required: ["flag"] }],
        },
        "copy-down of a transform-#7 neutralized field": {
          type: "object",
          properties: {
            properties: { type: "object", properties: { x: { type: "string" } } },
          },
          oneOf: [{ required: ["properties"] }],
        },
        "dropped keyword (unrepairable branch)": {
          type: "object",
          properties: { a: { type: "string" } },
          oneOf: [{ required: ["a"] }, { required: ["zzz"] }],
        },
        "dropped keyword (non-object branch)": {
          type: "object",
          properties: { a: { type: "string" } },
          oneOf: [{ type: "object", properties: { a: {} } }, { type: "string" }],
        },
        "rescued un-flattenable allOf root": {
          allOf: [{ $ref: "#/$defs/Input" }],
          $defs: { Input: { type: "object", properties: { a: { type: "string" } } } },
        },
        "bare union root with object branches": {
          oneOf: [
            { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
          ],
        },
        "nested composition": {
          type: "object",
          properties: {
            filter: {
              type: "object",
              properties: { q: { type: "string" }, id: { type: "string" } },
              oneOf: [{ required: ["q"] }, { required: ["id"] }],
            },
          },
        },
        "GitHub MCP issue_write (the transform-#3 fixture)": {
          type: "object",
          properties: {
            issue_fields: {
              type: "array",
              items: {
                type: "object",
                properties: { name: { type: "string" } },
                required: ["value"],
              },
            },
          },
        },
        "empty root": {},
        "mergeable allOf beside an unusable union": {
          type: "object",
          properties: { a: {} },
          allOf: [{ type: "object", properties: { b: {} } }],
          oneOf: [{ type: "string" }],
        },
        "union branch carrying its own union": {
          type: "object",
          properties: { a: { type: "string" }, b: { type: "string" } },
          oneOf: [
            { type: "object", anyOf: [{ properties: { a: { type: "string" } } }] },
            { type: "object", properties: { b: { type: "string" } } },
          ],
        },
        "union branch carrying its own allOf (kept)": {
          type: "object",
          properties: { a: { type: "string" }, b: { type: "string" } },
          oneOf: [
            { type: "object", allOf: [{ properties: { a: { type: "string" } } }] },
            { type: "object", properties: { b: { type: "string" } } },
          ],
        },
        "composition on a union branch's property (kept)": {
          type: "object",
          properties: { a: { type: "string" }, b: { type: "string" } },
          oneOf: [
            {
              type: "object",
              properties: { a: { anyOf: [{ properties: { x: { type: "string" } } }] } },
            },
            { type: "object", properties: { b: { type: "string" } } },
          ],
        },
        "union branch with a non-object type": {
          type: "object",
          properties: { a: { type: "string" } },
          oneOf: [
            { type: "object", properties: { a: {} }, required: ["a"] },
            { type: "string", properties: { a: {} }, required: ["a"] },
          ],
        },
      };

      for (const [name, input] of Object.entries(fixtures)) {
        test(name, () => {
          const once = sanitizeToolSchema(input);
          expect(sanitizeToolSchema(once)).toEqual(once);
        });
      }
    });
  });
});
