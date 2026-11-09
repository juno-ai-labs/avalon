/**
 * Sanitize a tool's JSON Schema before it is handed to the model.
 *
 * Why this exists
 * ---------------
 * Tool schemas reach the LLM verbatim — for MCP tools the third-party
 * server's `inputSchema` is forwarded as-is (`rawJsonSchema` in
 * `buildToolDefinitions`). Some providers validate that schema strictly
 * and reject the *entire* request (every tool, not just the bad one) on
 * the first violation. The one that bit us in production was Google
 * Gemini via OpenRouter:
 *
 *   OpenRouter 400 — Provider: Google (Google AI Studio), INVALID_ARGUMENT:
 *   GenerateContentRequest.tools[0].function_declarations[50]
 *     .parameters.properties[issue_fields].items.required[0]:
 *     property is not defined
 *
 * That message is a *symptom*, not the cause. The GitHub MCP `issue_write`
 * tool's `issue_fields.items` schema contained constructs Gemini's
 * function-declaration schema (a strict OpenAPI 3.0 subset) does not
 * support: a property typed with a `type` ARRAY (`value: { type:
 * ["string","number","boolean"] }`) and an `enum` on a boolean property
 * (`delete: { type: "boolean", enum: [true] }`). When Gemini's translator
 * hits an unsupported construct it drops the enclosing `properties` object,
 * after which the (perfectly valid) `required: ["field_name"]` dangles —
 * hence the misleading "property is not defined". The root causes were
 * confirmed empirically by bisecting the real schema against live Gemini
 * inference via OpenRouter; OpenAI and Anthropic accept all of it.
 *
 * What it does (applied to EVERY tool for EVERY model)
 * ----------------------------------------------------
 * The transforms only remove or normalize constructs that carry no real
 * constraint for a model's tool call. Each was verified against live Gemini:
 *
 *   1. Resolve a `type` ARRAY, which Gemini rejects outright (it requires a
 *      scalar `type`). Two cases, and they are not the same kind of loss:
 *
 *      a. NULLABLE single type — exactly one non-`"null"` member plus `"null"`,
 *         in either order, duplicates tolerated. Rewritten to
 *         `anyOf: [ <T branch>, {type:"null"} ]`, where the T branch carries
 *         the node's type-bearing keywords (`minLength`, `enum`, `properties`,
 *         `items`, bounds, …) under `type: T` and the node keeps its
 *         annotations. The branch is re-entered through this same walk, so
 *         every per-node transform applies to it — #12 retypes it to `"object"`
 *         when it carries `properties`, #13 drops an unsupported `pattern` into
 *         prose ON the branch, #2 filters its `enum`, #3 resolves its
 *         `required` against its own `properties`.
 *
 *         Collapsing this case instead was lossy in a way that broke callers in
 *         production. A model handed `{type:"string", minLength:1,
 *         description:"… or send null …"}` cannot express "none" in the half of
 *         the declaration it treats as binding, so it INVENTS a value that
 *         satisfies the type: `slack_send_message.thread_ts` (authored
 *         `type:["string","null"], minLength:1`) received `"/"`, `". "`,
 *         `".000001"` and the like for thousands of calls, each refused by
 *         Slack and each retried; a Drive pagination cursor had already been
 *         seen taking `"x"`, `" "`, `"undefined"`, `"null"` and `"/"`. Prose
 *         loses to the schema every time. The `anyOf` shape is not a guess: it
 *         passes under `properties` on grok-4.3/4.5/4.6,
 *         gemini-3.5/3.6/3.7-flash and gpt-5.6-terra/sol/luna, and it ships
 *         today on every pagination cursor of six connectors. No "Accepts T or
 *         null." note is added — the schema now says it — and an `enum` that
 *         listed `null` contributes only its non-null members to the branch,
 *         with no "May also be null." note, since the null branch carries that.
 *         A sibling `enum`/`const` that EXCLUDES one arm keeps case (b)
 *         instead: those keywords are AND-ed with `type`, so
 *         `{type:["string","null"], enum:["x"]}` means "must be \"x\"", and a
 *         union whose null branch the enum never reaches would admit a value
 *         the node forbade.
 *
 *         Four shapes opt out. The parameters ROOT, which has to be an object
 *         for every provider (transform #9 owns it). A branch of a ROOT
 *         `anyOf`/`oneOf`, because a root union branch carrying its OWN `anyOf`
 *         is 0/3 on Grok — rewriting there would turn a usable branch into one
 *         rule (a) drops, taking the whole keyword and every shape it
 *         advertised with it. And a COMPOSITION BRANCH whose `required` reaches
 *         the ENCLOSING node's `properties` — the extra scope transform #8
 *         gives it — because nesting such a name inside an `anyOf` puts it two
 *         levels from that scope, where transform #3 prunes it away entirely
 *         (a branch whose `required` its own `properties` cover needs no
 *         exception). All three keep case (b). (One residue is known and accepted: a `$defs` target
 *         rewritten this way, then inlined into a root union branch by
 *         transform #14, is unusable for the same 0/3 reason and still drops
 *         the keyword — the same narrow class #14 already documents.)
 *
 *      b. Everything else — a genuine MULTI-type union, which has no shape
 *         every provider accepts. Collapsed to the first non-`"null"` member
 *         (`["string","number","boolean"]` → `"string"`) with the alternatives
 *         folded into `description`; an array of only `"null"` drops the
 *         `type`. The lost alternatives are advisory — arguments are still
 *         validated at dispatch against the tool's zod schema and by the remote
 *         MCP server.
 *   2. Constrain `enum` to Gemini's rule: it is accepted ONLY as a list of
 *      strings on a string-typed (or type-less) property. So drop `enum`
 *      entirely when the node has an explicit non-string type (boolean,
 *      number, integer, array, object, null), and otherwise filter it to its
 *      string members (dropping any non-string leftovers — e.g. after a union
 *      `type` collapsed to "string") and omit it if none remain. `const`,
 *      which Gemini DOES support on every type, is left untouched — do not
 *      convert it to `enum`, which would manufacture the rejected case.
 *   3. Drop `required` entries with no matching key in the SAME node's own
 *      `properties` map (evaluated per node, against direct `properties`
 *      only — Gemini does not resolve composition or parent scope, and a
 *      `required` naming an absent property is a hard 400). A genuinely
 *      dangling `required` is invalid everywhere; this is a safety net, not
 *      the primary fix for the issue above.
 *   4. Strip the `$schema` dialect declaration, which function-calling APIs
 *      ignore. We deliberately KEEP `$id`: for schemas that use relative
 *      `$ref`s it defines the base URI / identifies subschemas, and we
 *      preserve `$ref`, so dropping `$id` could break reference resolution.
 *   5. Flatten a top-level `allOf` of object subschemas into a single object
 *      schema (merge `properties`, union `required`). A function's parameters
 *      root produced by a Zod intersection (`a.and(b)`) renders as `{ allOf:
 *      [ {type:object…}, {type:object…} ] }` with no root `type`/`properties`.
 *      xAI (Grok) via OpenRouter strictly requires the parameters ROOT to be a
 *      plain object schema and rejects the whole request with a 502 "Invalid
 *      arguments passed to the model" on a composition root; Gemini tolerates
 *      it. Merging is safe for tool calling — `allOf` means "satisfy every
 *      branch", i.e. an object carrying the union of all branches' properties.
 *      Confirmed empirically against live Grok (`document__convert_excel` /
 *      `document__ocr`). Only `allOf` is flattened (a true intersection);
 *      `anyOf`/`oneOf` roots are left untouched. The flatten is applied ONLY
 *      when it's lossless — every branch is a plain object schema with
 *      merge-safe keywords; a branch carrying `$ref`, `not`, `if`, nested
 *      composition, a non-object `type`, etc. leaves the `allOf` intact rather
 *      than dropping the unmerged constraint.
 *   6. Drop a boolean `additionalProperties: false`. xAI (Grok) via OpenRouter
 *      rejects that form on a NESTED object schema with a hard 400 ("property
 *      schema 'false' is not supported"), failing the WHOLE request (every
 *      tool). The constraint it carries — "no keys beyond those declared" — is
 *      advisory for tool calling (arguments are validated at dispatch against
 *      the tool's zod schema and by the remote MCP server), so it is dropped
 *      rather than allowed to sink the request. `additionalProperties: true`
 *      (the JSON Schema default, a no-op) is left as-is, and an OBJECT-valued
 *      `additionalProperties` is a real subschema constraint every provider
 *      accepts — it is kept and recursed into. Confirmed against the production
 *      failure (Notion `notion-create-pages`,
 *      `pages[].properties.properties.additionalProperties`).
 *   7. Neutralize a tool parameter literally NAMED `properties` whose schema is
 *      object-shaped. xAI (Grok) via OpenRouter mis-reads such a field as the
 *      JSON-Schema `properties` keyword — it descends in, injects an
 *      `additionalProperties: false`, then rejects its own injection, failing the
 *      WHOLE request with `/properties/properties/additionalProperties: property
 *      schema 'false' is not supported` (so transform #6 alone never helped —
 *      the rejected `false` is xAI's own, not ours). Notion's `notion-create-pages`
 *      / `update-page` carry exactly this field (the page's `properties` map), so
 *      it 400s the default Grok agent. xAI accepts the field only when it does NOT
 *      look like an object schema, so we collapse an object-shaped
 *      `properties`-named node to annotations only (`description` / `title`).
 *      Advisory-safe (args validated at dispatch + by the remote server; Notion's
 *      `properties` is an open per-database map with no fixed sub-schema), and the
 *      key name is never changed so the model still emits the right argument key.
 *      Confirmed live: `x-ai/grok-4.3` 400→200, Gemini/Claude unaffected.
 *   8. Resolve a COMPOSITION BRANCH's `required` against the branch's own
 *      `properties` UNIONED with the enclosing node's `properties`, and — at the
 *      parameters ROOT only — make the surviving branch self-sufficient by copying
 *      the referenced property subschemas down into it and setting
 *      `type: "object"`. This is the narrow, measured exception to transform #3.
 *      The ordinary way to say "pass exactly one of these" puts the properties on
 *      the parent and only `required` in each branch:
 *
 *        { type: "object", properties: { query: …, memoryItemId: … },
 *          oneOf: [ { required: ["query"] }, { required: ["memoryItemId"] } ] }
 *
 *      which is how JSON Schema composition works, and which transform #3 alone
 *      sanitized to `oneOf: [{}, {}]` — a root xAI (Grok) hard-rejects
 *      (`tool parameter root must be an object type (root schema is an
 *      anyOf/oneOf union with a non-object branch)`, failing EVERY tool in the
 *      request), and which Gemini/OpenAI accept while silently losing the
 *      constraint, letting the model send both parameters or neither. Measured on
 *      xAI for branches of a ROOT union: `{type:"object", …}` or `{properties:…}`
 *      is accepted with EITHER alone sufficing; a bare `{required:[…]}` or `{}` is
 *      a 400. Hence the copy-down, which also makes the branch idempotent under
 *      this sanitizer (a second pass finds every `required` name in the branch's
 *      OWN `properties` and changes nothing).
 *
 *      Two limits are load-bearing, both measured:
 *        - The parent scope is the ENCLOSING node only, and only for
 *          `allOf`/`anyOf`/`oneOf` elements. Widening transform #3 to resolve
 *          `required` against ALL ancestors at every node reintroduces the hard
 *          Gemini 400 that transform #3 exists to prevent ("required fields
 *          ['value'] are not defined in the schema properties" — still true on
 *          gemini-3.5/3.6/3.7-flash). Every non-branch node keeps transform #3
 *          exactly as it is, and so do `if`/`then`/`else` and `dependentSchemas`,
 *          which are not composition arrays.
 *        - The copy-down is ROOT-ONLY. The identical bare-`required` union nested
 *          under a property is accepted by all nine measured models including
 *          every Grok version, so a nested composition keeps its `required` (that
 *          is the fix) and is otherwise left alone — no provider constrains it,
 *          and churning it risks the transform-#5 `allOf` flatten.
 *      Only the names in the branch's own `required` are copied, so a branch does
 *      not inherit the parent's whole property set — and a single ceiling
 *      (`MAX_ROOT_COPY_DOWN`) bounds the copy-down across ALL branches of one
 *      root composition, because the per-branch bound does not bound N branches
 *      × P names. Past the ceiling the repair is skipped, leaving the branches
 *      bare for rule (a) below to drop.
 *   9. Guarantee the parameters ROOT is one xAI will accept, as a final pass.
 *      xAI rejects a root that is not an object type, and the rejection takes the
 *      whole request (every tool) with it. Two distinct rules, each measured
 *      against grok-4.3/4.5/4.6 (and confirmed inert on the six Gemini/OpenAI
 *      models) through OpenRouter with `provider.allow_fallbacks: false` and one
 *      tool per request:
 *
 *        a. Every element of a root `anyOf`/`oneOf` must be a plain object that
 *           is object-shaped, and must not be `{}`. A branch that declares a
 *           `type` is judged on that alone (`type: "object"` passes, anything
 *           else fails even when the branch also carries `properties` — measured
 *           0/3, identical to a bare `{type:"string"}`); a branch with no `type`
 *           passes on `properties`. This holds even when the root ITSELF declares
 *           `type: "object"` and `properties` — an object root does not excuse a
 *           non-object branch. Rule (a) runs BEFORE the transform-#5 flatten,
 *           since that flatten refuses to merge an `allOf` while a union sibling
 *           is present; dropping the union afterwards would strand an `allOf`
 *           that the next pass would merge, breaking idempotence. A
 *           branch that still fails after #8 cannot be repaired (its `required`
 *           names something no `properties` map declares — the parent supplies it
 *           only via `patternProperties`/`additionalProperties`, or not at all —
 *           or it is a `$ref`/scalar/boolean branch), so the whole keyword is
 *           dropped. Losing one tool's constraint is strictly better than losing
 *           every tool in the request.
 *        b. A root carrying a composition keyword but declaring neither `type`
 *           nor `properties` is rejected on its OWN account, whatever the branches
 *           look like: `{allOf:[{$ref:…}], $defs:…}` and
 *           `{allOf:[{type:"object",…}, {not:…}]}` are both 0/3 on Grok. Adding
 *           `type: "object"` to such a root makes exactly those cases pass 9/9
 *           without touching the composition — so the un-flattenable root `allOf`
 *           that transform #5 deliberately preserves is RESCUED rather than
 *           discarded, and it stops being the silent 400 it is today. A non-object
 *           `type` the root declared for itself IS rewritten to `"object"` and
 *           recorded in the description — measured, such a root is rejected by
 *           every model. Nested nodes keep their declared types unless transform
 *           #12 applies.
 *
 *      Rule (a) is all-or-nothing per keyword, because ONE unusable branch
 *      poisons the whole union on xAI even when its siblings are good (0/3 with a
 *      `{type:"string"}` sibling next to a valid object branch). Filtering the bad
 *      branches out instead is accepted by xAI (3/3) but is NOT what we do — it
 *      advertises a narrower tool, telling the model an arm is invalid so it never
 *      calls that shape, with nothing to surface the loss. Dropping the keyword
 *      leaves the parent's `properties` fully visible, so every shape stays
 *      callable and a wrong COMBINATION comes back from dispatch/the remote
 *      server as a recoverable tool error.
 *
 *      A branch's OWN `anyOf`/`oneOf` disqualifies it too, whatever else it
 *      declares: `{type:"object", anyOf:[…]}` as a root union branch is 0/3 on
 *      Grok, as is a branch carrying both `allOf` and `anyOf` — the union is what
 *      poisons it. Scope is the branch's own keys and never its subtree: a
 *      composition on a branch's PROPERTY is accepted 9/9, one or two levels
 *      down, so a subtree scan would destroy constraints every provider honours.
 *      A branch's own `allOf` is likewise accepted 9/9 (even with a
 *      bare-`required` sub-branch), the same intersection-vs-union asymmetry xAI
 *      applies to the root — hence `ROOT_UNION_KEYS`, not `COMPOSITION_KEYS`.
 *
 *      A root union of `$ref` branches is no longer a loss — transform #14 below
 *      inlines the targets so the union survives. What remains is the narrow
 *      residue it cannot inline: a target that is not a plain object schema
 *      (a union of its own included, which is what a `$defs` entry transform
 *      #1a rewrote becomes), one whose expanded size exceeds the copy-down
 *      ceiling, and a self-referential root pointer. Those branches stay
 *      unusable and still drop the keyword.
 *
 *      Rule (b) covers EVERY root, not only composition roots. A property sweep
 *      over recursive shapes (`__tests__/tool-schema/property/`) found the
 *      narrower gate emitting unusable roots for whole classes the fixtures
 *      never reached: a scalar or array root (reachable from transform #1
 *      collapsing `{type:["string","null"]}`), an annotation-only root, a
 *      `$defs`-only root, and a root whose `type` contradicts its `properties` —
 *      that last one rejected by all nine models, the only rule here with no
 *      tolerant provider. Rule (b) also DROPS a `const` or `$ref` carried by the
 *      root: measured `root schema is a const` / `root schema is a $ref`, 400
 *      even alongside `type: "object"` and `properties`, and for `$ref` even
 *      when the target resolves. Nested `const`/`$ref` are meaningful and
 *      untouched.
 *
 *      A root `allOf`'s BRANCHES are deliberately not constrained by (a):
 *      measured, xAI accepts `$ref`, `not`, nested-`allOf` and even scalar
 *      branches under an `allOf` as long as (b) holds — only `anyOf`/`oneOf`
 *      branches are validated individually. A bare union root whose branches are
 *      all object-carrying is accepted too (xAI infers object-ness from them), so
 *      (b) leaves it alone. Compositions nested below the root are untouched.
 *
 *  10. Drop an EMPTY array-valued keyword (`allOf`/`anyOf`/`oneOf`/`prefixItems`)
 *      at any depth. xAI rejects one anywhere in the tree — `/properties/a/oneOf:
 *      [] has less than 1 item` — and it carries no constraint (an `allOf` of
 *      nothing is satisfied by everything). Empty OBJECTS (`properties: {}`,
 *      `$defs: {}`) and an empty `required: []` are accepted and left alone;
 *      `enum: []` and `required: []` were already omitted by transforms #2/#3.
 *  11. Drop a `$ref` whose LOCAL target does not resolve. xAI resolves `#/…`
 *      pointers itself and 400s the whole request on a dangling one
 *      (`unresolvable $ref '#/$defs/Nope'`), which a third-party MCP server
 *      produces easily by shipping a subschema without its definitions — or by
 *      putting `$defs` on a nested node, since `#/$defs/X` is anchored at the
 *      document ROOT and a nested `$defs` is unaddressable that way. External
 *      refs (`https://…`) and resolvable non-`$defs` pointers (`#/properties/a`)
 *      are both accepted by xAI and left alone. Only the `$ref` keyword is
 *      dropped, so the rest of the node survives.
 *
 *  12. Give any node carrying `properties` an explicit `type: "object"`. Gemini
 *      rejects the type-less form outright — "Unable to submit request because
 *      `t` functionDeclaration `parameters.b` schema specified incorrect schema
 *      type field. For schema with properties, schema type should be OBJECT" —
 *      on gemini-3.5/3.6/3.7-flash, and rejects a CONTRADICTORY declared type
 *      (`{type:"string", properties:{…}}`) the same way, so the type is
 *      overwritten rather than merely defaulted. It is not composition-specific:
 *      a plain property subschema and an `items` schema fail identically. xAI
 *      and OpenAI accept every one of those forms, which is why this survived
 *      until a property sweep over recursive shapes went looking for it. The
 *      root is exempt in Gemini's own validator, but the rule is applied
 *      uniformly because it costs nothing and one rule beats two.
 *
 *      It is resolved during the node's type resolution, not patched onto the
 *      finished node, so `dropEnum` sees the real type — an `enum` left on a
 *      node that has just become an object would otherwise be dropped by the
 *      NEXT pass instead of this one, breaking idempotence. A discarded
 *      contradictory type is folded into the description like transform #1's.
 *      This also makes a contradictory root-union BRANCH repairable: it arrives
 *      at transform #9 already retyped, so the constraint survives instead of
 *      the whole keyword being dropped.
 *
 *  13. Drop a `pattern` that uses a regex construct a provider's validator
 *      refuses, echoing it into the description instead. Measured: `(?=`, `(?!`,
 *      `(?<=`, `(?<!` AND named groups `(?<name>` are rejected by gpt-5.6-sol
 *      and gpt-5.6-terra (`Invalid JSON schema: regex lookaround is not
 *      supported` — the message says lookaround, but a named group fails
 *      identically, so the giveaway is the `(?<` prefix); a BACKREFERENCE
 *      (`\1`–`\9`) is rejected by grok-4.5. Non-capturing `(?:` is accepted
 *      everywhere and is deliberately NOT caught. This is the defect that broke
 *      Monad's own `spaces__invite_member` on every OpenAI model — a whole-
 *      request 400 from one tool's email pattern. The scan tracks backslash
 *      escaping and character classes, so a literal `\(\?=` or a `[(?=]` class
 *      keeps its pattern: dropping a pattern that would have been accepted
 *      costs a real constraint on every provider.
 *  14. Inline a ROOT union branch that is a local `$ref`, so the union survives
 *      rule (a) instead of being dropped whole. `z.union([A, B])` renders as
 *      `{anyOf:[{$ref},{$ref}], $defs}` and xAI does not resolve a `$ref` union
 *      branch (0/3 even with `type: "object"` on the root) — so rule (a) used to
 *      drop the keyword, which for a root whose properties live entirely in
 *      `$defs` left the tool advertising NO parameters. Inlining produces
 *      ordinary object branches, accepted 9/9. Only branches that are not
 *      already usable are inlined, one level deep (a `$ref` inside the target
 *      resolves on its own, which is what makes a recursive definition
 *      terminate here), with branch keywords winning over the target's per
 *      2020-12 `$ref` semantics and a cap for the same reason the copy-down has
 *      one. A branch whose target is not a plain object schema stays unusable
 *      and still falls through to the drop.
 *
 * When (1b) or (2) discards information the model could use — a collapsed
 * multi-type union, or a wholly-dropped `enum` — that constraint is folded into
 * the node's `description` as prose ("Accepts string, number, or boolean.",
 * "Allowed values: true.") so the model still sees it. `description` is a free
 * string every provider accepts, so this is always safe. Prose is the fallback,
 * never the first choice: where a shape every provider accepts exists, the
 * schema says it instead — which is the whole of (1a).
 *
 * It deliberately leaves meaningful validation keywords (`format`,
 * `pattern`, object- or `true`-valued `additionalProperties`, `const`, string
 * `enum`, length/range bounds, `$ref`, `$id`) intact so compliant providers
 * keep their guidance. The two structural exceptions are both xAI-rejected: the
 * boolean `false` form of `additionalProperties` (transform #6), and the
 * object-structure of a property literally named `properties` (transform #7),
 * which is collapsed to annotations only.
 *
 * The walk is keyword-aware: it only recurses into positions that JSON
 * Schema defines as subschemas, and treats `enum` / `const` / `default` /
 * `examples` values (and the `required` array itself) as opaque data. That
 * way a tool parameter literally named `properties` or `required`, or an
 * example value that happens to contain those keys, is never mistaken for
 * schema structure and corrupted by OUR walk. (Transform #7 separately
 * rewrites a `properties`-named object field — not because we confuse it, but
 * because xAI's parser does.)
 *
 * Robustness: the walk is depth-bounded (`MAX_DEPTH`) so a pathologically
 * nested third-party schema can't overflow the stack, and the entry point
 * tolerates a non-object root (a boolean schema, or a malformed server's
 * payload) by returning an empty object instead of throwing. Past the bound
 * the subtree is *replaced*, not returned verbatim — a bomb passed through
 * would simply overflow one frame later, when the caller serializes the
 * result into a request body. For the same reason nothing in this module
 * hands an untrusted value to `JSON.stringify`, which recurses on its own and
 * so would reintroduce the unbounded walk the depth guard exists to prevent.
 *
 * Non-mutating, but NOT a full deep clone: the returned object has a fresh
 * spine (every object/array node the walk descends into is rebuilt), so the
 * input `rawJsonSchema` — shared across runs — is never mutated. Opaque
 * leaf values (`enum`, `const`, `default`, `examples`, `pattern`, …) are
 * carried over by reference, so callers must treat the result as read-only.
 */

/** Hard cap on recursion depth to bound stack usage on adversarial input. */
const MAX_DEPTH = 100;

/** Metadata keyword(s) the function-calling APIs ignore; safe to drop. */
const METADATA_KEYS = new Set(["$schema"]);

/**
 * Keys skipped at the keyword level — none are valid JSON Schema keywords.
 * Only `__proto__` carries real danger (its setter mutates the prototype
 * rather than creating an own property; `safeSet` uses `defineProperty` for
 * it inside maps); `constructor`/`prototype` are included conservatively.
 */
const PROTO_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Single-subschema keywords (value is a subschema, or a boolean).
 * `additionalProperties` is handled by a dedicated branch in `sanitizeSchemaNode`
 * (transform #6 drops its boolean `false` form and recurses into the object
 * form), so it is intentionally NOT listed here — that dedicated branch
 * `continue`s before the generic single-subschema handler is reached. */
const SUBSCHEMA_SINGLE_KEYS = new Set([
  "unevaluatedProperties",
  "additionalItems",
  "unevaluatedItems",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
]);

/** Array-of-subschema keywords. */
const SUBSCHEMA_ARRAY_KEYS = new Set([
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
]);

/** The three keywords whose array elements are COMPOSITION BRANCHES — branches
 * that JSON Schema evaluates against the enclosing node, so their `required` may
 * legitimately name a property the enclosing node declares (transform #8).
 * `prefixItems` is in `SUBSCHEMA_ARRAY_KEYS` but NOT here: its elements are the
 * item schemas of a tuple, a fresh scope, not branches of the enclosing object. */
const COMPOSITION_KEYS = new Set(["allOf", "anyOf", "oneOf"]);

/**
 * Transform #1, nullable case: the JSON Schema type names that may stand
 * opposite `"null"` in a `type` array for the `anyOf` rewrite to fire. An
 * unrecognized name is left to the collapse — rewriting `{type:["foo","null"]}`
 * into a two-branch union would emit an unmeasured shape built around a type no
 * provider knows, where the collapse at least degrades to prose.
 */
const NULLABLE_UNION_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
]);

/**
 * Keywords whose presence on a node disqualifies it from the nullable rewrite.
 * Each is a construct the emitted `anyOf` would have to be evaluated ALONGSIDE
 * (an `anyOf` sibling to an `oneOf`, an `if`/`then` keyed off the node's type,
 * …), and no such combination has been measured against a provider. A node
 * carrying one keeps transform #1's collapse.
 */
const NULLABLE_REWRITE_BLOCKERS = [
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
] as const;

/**
 * The type-bearing keywords that move from a nullable node onto its typed
 * branch, where they constrain the non-null value they were written for. Every
 * one of them is meaningless against `null`, so leaving them on the outer node
 * beside the union would say something the author never meant.
 *
 * The object-structure keywords move as a GROUP, and that is load-bearing
 * rather than tidy. `additionalProperties` is defined against the keys that
 * `properties` and `patternProperties` did NOT match *in the same schema
 * object*, so moving two of the three and stranding the third silently changes
 * what the schema says: for `{properties:{a}, patternProperties:{"^x":…},
 * additionalProperties:{…}}`, a key `x1` was exempt from
 * `additionalProperties` and, split across the union boundary, stops being
 * exempt. `dependencies` / `dependentRequired` / `dependentSchemas` travel with
 * them because they describe the same object form.
 *
 * Two groups deliberately stay OUTSIDE. Annotations (`description`, `title`,
 * `default`, `examples`, `deprecated`, `readOnly`, `writeOnly`, `$comment`)
 * describe the property as a whole, including its null case, and duplicating a
 * description into the branch would show the model the same sentence twice. And
 * `unevaluatedProperties` / `unevaluatedItems` are defined over the annotations
 * every applicable schema produced — the `anyOf` branches included — so the
 * outer node is exactly where they belong; moving one inside would narrow it to
 * the branch's own keywords. Anything else the node carries (`$defs`, `$id`, an
 * unknown keyword) stays outside too, keeping the treatment it has today.
 */
const NULLABLE_BRANCH_KEYS = new Set([
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "enum",
  "const",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "uniqueItems",
  "properties",
  "patternProperties",
  "required",
  "additionalProperties",
  "propertyNames",
  "minProperties",
  "maxProperties",
  "dependencies",
  "dependentRequired",
  "dependentSchemas",
  "contentMediaType",
  "contentEncoding",
]);

/**
 * Ceiling on how many property subschemas transform #8 may copy down across ALL
 * branches of one root composition.
 *
 * The per-branch bound (a branch's own `required`) does NOT bound the total: a
 * root `oneOf` of N branches each requiring P parent properties copies N × P
 * subschemas from an input that is only O(N + P). Both counts are
 * attacker-controlled for a third-party MCP `rawJsonSchema`, and the references
 * are shared in memory but EXPAND on `JSON.stringify` when the schema is written
 * into the request — measured at N=2000, P=100, a 1.2 MB input sanitizes to a
 * 17.5 MB request body, a 14x amplification paid on every model call. That is
 * the same class of hazard `flattenRootAllOf` guards against below.
 *
 * Past the ceiling the repair is skipped, which leaves the branch bare and lets
 * transform #9 rule (a) drop the keyword — the module's usual tiebreak, losing
 * one tool's constraint rather than degrading every request. The cap is far
 * above any legitimate tool schema (a large discriminated union is tens of
 * branches with a handful of `required` names each).
 */
const MAX_ROOT_COPY_DOWN = 512;

/**
 * Recursive size of a subtree, in nodes and keys, stopping as soon as it exceeds
 * `cap`. Used to price transform #14's inlining: counting only a target's
 * TOP-LEVEL keys is no bound at all, because `{type, properties}` costs 2 no
 * matter how large `properties` is — measured, that let a 0.11 MB schema with
 * 256 `$ref` branches expand to 26 MB of request body, a 242x amplification on
 * attacker-controlled input. Early exit keeps the pricing itself cheap and
 * bounded, and the depth guard mirrors the walk's.
 */
function subtreeWeight(value: unknown, cap: number, depth = 0): number {
  if (depth > MAX_DEPTH) return cap + 1;
  if (Array.isArray(value)) {
    let total = 1;
    for (const item of value) {
      total += subtreeWeight(item, cap - total, depth + 1);
      if (total > cap) return total;
    }
    return total;
  }
  if (!isPlainObject(value)) return 1;
  let total = 1;
  for (const item of Object.values(value)) {
    total += 1 + subtreeWeight(item, cap - total, depth + 1);
    if (total > cap) return total;
  }
  return total;
}

/** Longest `pattern` echoed into a description when transform #13 drops it.
 *  A regex is guidance at that point, and an unbounded one would crowd out the
 *  rest of the tool's description in the model's context. */
const MAX_PATTERN_IN_PROSE = 120;

/**
 * True if a `pattern` uses a regex construct some provider's validator refuses.
 * Measured, one tool per request, `provider.allow_fallbacks: false`:
 *
 *   - `(?=`, `(?!`, `(?<=`, `(?<!` and NAMED GROUPS `(?<name>` are all rejected
 *     by gpt-5.6-sol and gpt-5.6-terra (`Invalid JSON schema: regex lookaround
 *     is not supported`), and accepted by Gemini and Grok. The error says
 *     "lookaround", but a named group fails identically — the giveaway is the
 *     `(?<` prefix, not the semantics — so all of `(?<` goes.
 *   - A BACKREFERENCE (`\1`…`\9`) is rejected by grok-4.5 and accepted by the
 *     others.
 *   - Non-capturing `(?:` is accepted everywhere and must not be caught here.
 *
 * The scan tracks backslash escaping and character classes so a LITERAL `\(?=`
 * or a `[(?=]` class is not mistaken for the construct — dropping a pattern
 * that would have been accepted costs a real constraint on every provider.
 * Inside a class, `\1` is an octal escape rather than a backreference, so
 * backreference detection is suppressed there too.
 */
function usesUnsupportedRegexConstruct(pattern: string): boolean {
  // A deliberately NAIVE character-class scan: `[` opens, the next `]` closes.
  // RFC-correct regex treats a `]` in first position as a literal (`[]a]` is the
  // two-member class `]`,`a`), and an earlier revision of this function did too
  // — but the providers do not, and they are what we are modelling. Measured:
  // `^[(?=]+$` is accepted 5/5 (the `(?=` reads as class content under BOTH
  // parses), while `^[](?=)]+$` is REJECTED by gpt-5.6-sol/terra and accepted by
  // Grok and Gemini. That split is only explicable if OpenAI closes the class at
  // the first `]`, leaving `(?=` outside — i.e. the naive parse. Matching the
  // strict spec here would keep a pattern OpenAI 400s the whole request over.
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "\\") {
      const next = pattern[i + 1];
      if (!inClass && next !== undefined) {
        // `\1`–`\9` is a backreference (`\0` is NUL), rejected by grok-4.5.
        if (next >= "1" && next <= "9") return true;
        // `\k<name>` is a NAMED backreference, rejected by grok-4.5 AND
        // gpt-5.6-sol.
        if (next === "k" && pattern[i + 2] === "<") return true;
      }
      i++; // skip the escaped character
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") {
      inClass = true;
      continue;
    }
    if (char === "(" && pattern[i + 1] === "?") {
      const kind = pattern[i + 2];
      // `=`/`!` lookahead and `<` (lookbehind OR named group) are rejected by
      // the OpenAI models; `>` (atomic group) is rejected by grok-4.5. Inline
      // flags `(?i)` and non-capturing `(?:` are accepted everywhere and must
      // NOT be caught.
      if (kind === "=" || kind === "!" || kind === "<" || kind === ">") {
        return true;
      }
    }
  }
  return false;
}

/** Name → subschema maps. `properties` is listed here for completeness, but a
 * dedicated `key === "properties"` branch in `sanitizeSchemaNode` intercepts it
 * first (to apply transform #7) and `continue`s — so the generic map handler
 * only ever sees the others. Keep it in the set so that if the dedicated branch
 * is ever removed, `properties` still falls back to generic map sanitization
 * rather than being treated as opaque. */
const SUBSCHEMA_MAP_KEYS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Own-property test. `hasOwnProperty.call`, never `name in map`: the latter
 * answers `true` for a prototype member ("toString", "valueOf"), which would let
 * a `required: ["toString"]` survive against a `properties` map that never
 * declared it — the exact dangling `required` transform #3 exists to prune. */
function hasOwn(map: Record<string, unknown>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, name);
}

/** Join words as a human list: ["a"]→"a", ["a","b"]→"a or b", ["a","b","c"]→"a, b, or c". */
function humanJoin(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}

/**
 * Render one `enum` member for the human-readable prose we attach to a
 * description when the enum itself is dropped.
 *
 * Composite members are summarized rather than serialized. `JSON.stringify`
 * recurses over the value, so a third party could hand us a deeply nested
 * `enum` member and overflow the stack here — outside the walk's depth guard,
 * which bounds structural recursion only. The summary loses nothing a model
 * could act on: an enum of nested containers is not a constraint prose can
 * usefully express.
 */
function describeEnumValue(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    return Array.isArray(value) ? "[…]" : "{…}";
  }
  // `undefined` (illegal in JSON but reachable from a hand-built object)
  // stringifies to `undefined`, not a string.
  return JSON.stringify(value) ?? String(value);
}

/**
 * True if a (sanitized) schema node "looks like an object schema" to xAI's
 * tool-schema parser — i.e. carries `type: "object"` or any of the keywords it
 * descends through as object structure (`properties` / `patternProperties` /
 * `additionalProperties`). Used only by the transform-#7 collision check below.
 */
function looksObjectShapedToXai(node: Record<string, unknown>): boolean {
  return (
    node.type === "object" ||
    "properties" in node ||
    "patternProperties" in node ||
    "additionalProperties" in node
  );
}

/**
 * Transform #7 (xAI/Grok workaround). A tool parameter literally NAMED
 * `properties` whose schema is object-shaped makes xAI's validator mis-read it
 * as the JSON-Schema `properties` keyword: it descends in, injects an
 * `additionalProperties: false`, then rejects its own injection — failing the
 * WHOLE request with `/properties/properties/additionalProperties: property
 * schema 'false' is not supported` (verified live against `x-ai/grok-4.3`).
 * Notion's `notion-create-pages` / `update-page` tools carry exactly such a
 * field (the page's `properties` map), so this 400s the default Grok agent.
 *
 * xAI accepts the field only when it does NOT look like an object schema
 * (`{ description }`, `{}`, or a non-object `type` all pass). So we collapse an
 * object-shaped `properties`-named node to its non-structural keywords: the
 * `description` / `title` annotations plus the opaque data keywords `default` /
 * `examples` / `const` (verified live that xAI does NOT descend into these — it
 * treats them as data, not schema — so they preserve model guidance without
 * re-triggering the bug). Only the object-STRUCTURE keywords (`type: "object"`,
 * `properties`, `patternProperties`, `additionalProperties`, `required`, …) are
 * dropped. This is advisory-safe — arguments are passed through and validated at
 * dispatch + by the remote MCP server — and the field's object intent survives in
 * its description (Notion's `properties` is an open per-database map with no fixed
 * sub-schema, so little is lost). The key name is never changed, so the model
 * still emits the correct argument key.
 */
function neutralizeXaiPropertiesField(
  node: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof node.title === "string") out.title = node.title;
  out.description =
    typeof node.description === "string" && node.description.length > 0
      ? node.description
      : "An object.";
  // Opaque data keywords (not schema structure) — kept as model guidance; xAI
  // does not descend into them, so they don't re-trigger the collision.
  for (const k of ["default", "examples", "const"]) {
    if (k in node) out[k] = node[k];
  }
  return out;
}

/** Assign a key/value, using `defineProperty` for `__proto__` so a literal
 * `__proto__` key becomes an own property instead of mutating the prototype. */
function safeSet(out: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(out, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    out[key] = value;
  }
}

/** Recurse into a value that JSON Schema defines as a single subschema. In
 * draft-07 `items` / tuple forms a value may also be an array of subschemas. */
function sanitizeSubschema(value: unknown, depth: number): unknown {
  // Arrays count toward the depth budget too. Counting only object nodes left
  // the bound bypassable by a chain of nested arrays (`items: [[[[…]]]]`),
  // which recurses here without ever reaching `sanitizeSchemaNode` — a third
  // party could overflow the stack with a schema the guard claimed to bound.
  //
  // `true` — the accept-anything boolean schema — rather than the value: past
  // MAX_DEPTH the input is adversarial, and returning it would only move the
  // overflow to whoever serializes our output.
  if (depth > MAX_DEPTH) return true;
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeSubschema(v, depth + 1));
  }
  if (isPlainObject(value)) return sanitizeSchemaNode(value, depth);
  return value; // boolean or other primitive (e.g. `not: false`)
}

/** Recurse into a name → subschema map (`properties`, `$defs`, …). */
function sanitizeSchemaMap(value: unknown, depth: number): unknown {
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [name, sub] of Object.entries(value)) {
    safeSet(
      out,
      name,
      isPlainObject(sub) || Array.isArray(sub)
        ? sanitizeSubschema(sub, depth)
        : sub,
    );
  }
  return out;
}

/**
 * Sanitize a `properties` MAP and apply transform #7 to it: a child property
 * literally named `properties` whose schema is object-shaped trips xAI's parser,
 * so it is collapsed to annotations only. (Only the `properties` map triggers the
 * `/properties/properties` collision — `patternProperties`/`$defs` keys are
 * patterns and definition names, not property names, so they go through the
 * generic map handler.)
 *
 * Computed once per node, ahead of the key walk, because two things need the
 * SANITIZED map rather than the raw one: the `properties` keyword itself, and
 * transform #8, which resolves a composition branch's `required` against it and
 * copies subschemas down from it. Copying the sanitized form is what makes
 * transform #8 idempotent — a raw subschema copied into a branch would still be
 * awaiting collapse, so a second pass would not be a no-op.
 */
function sanitizePropertiesKeyword(value: unknown, depth: number): unknown {
  const mapped = sanitizeSchemaMap(value, depth);
  if (
    isPlainObject(mapped) &&
    isPlainObject(mapped.properties) &&
    looksObjectShapedToXai(mapped.properties)
  ) {
    mapped.properties = neutralizeXaiPropertiesField(mapped.properties);
  }
  return mapped;
}

/**
 * Transform #8, second half (ROOT branches only): make a composition branch
 * self-sufficient so it stands on its own as an object schema.
 *
 * A branch whose `required` survived the parent-scope resolution but whose names
 * live in the PARENT's `properties` gets those subschemas copied down and, if it
 * declared no `type`, `type: "object"`. Only the names in this branch's own
 * `required` are copied — a branch does not inherit the parent's whole property
 * set. A branch that needs no repair is returned unchanged (same reference), so
 * the common case of an already-object branch costs nothing and re-sanitizing is
 * a no-op.
 *
 * `parentProperties` is the parent's SANITIZED map, so the copied subschemas are
 * shared by reference with the parent's — consistent with the module's
 * read-only-result contract, and cheaper than a second sanitize of the same
 * subtree.
 *
 * A branch naming something the parent supplies only via `patternProperties` /
 * `additionalProperties` cannot be made self-sufficient. It cannot reach here
 * with such a name (the first half of transform #8 resolves `required` against
 * explicit `properties` only, so the name was already pruned), leaving an
 * unrepairable branch for transform #9 to catch.
 */
function makeBranchSelfSufficient(
  branch: Record<string, unknown>,
  parentProperties: Record<string, unknown> | null,
  budget: { remaining: number },
): Record<string, unknown> {
  if (!parentProperties) return branch;
  if (!Array.isArray(branch.required) || branch.required.length === 0) {
    return branch;
  }
  // `required`/`properties` are object-only keywords, so repairing a branch that
  // declares a non-object `type` would emit a self-contradictory schema — and an
  // unmeasured one, in a function whose whole justification is emitting only
  // shapes measured to pass. Leave it alone; transform #9 rule (a) drops the
  // keyword, since a non-object-typed branch is unusable at a root union anyway.
  if (hasOwn(branch, "type") && branch.type !== "object") return branch;
  const ownProperties = isPlainObject(branch.properties)
    ? branch.properties
    : null;

  // `missing` — declared by the parent, to be copied down. `unsatisfiable` —
  // declared by NEITHER map. The latter is unreachable through the walk (the
  // parent-scope resolution has already pruned any such name), but it is
  // handled rather than trusted: the invariant this function must not break is
  // that every emitted `required` name is a declared property, so an
  // unsatisfiable name is dropped from `required` instead of being carried
  // through on an unchanged branch. A future refactor that makes this reachable
  // then degrades to transform #3's behavior rather than emitting the dangling
  // `required` transform #3 exists to prevent.
  const missing: string[] = [];
  const unsatisfiable = new Set<string>();
  for (const name of branch.required) {
    if (typeof name !== "string") continue;
    if (ownProperties && hasOwn(ownProperties, name)) continue;
    if (hasOwn(parentProperties, name)) missing.push(name);
    else unsatisfiable.add(name);
  }
  if (missing.length === 0 && unsatisfiable.size === 0) return branch;
  // Global copy-down ceiling (see MAX_ROOT_COPY_DOWN). Skipping the repair
  // leaves the branch bare, so rule (a) drops the keyword rather than emitting a
  // request body inflated by an adversarial schema.
  if (missing.length > budget.remaining) return branch;
  budget.remaining -= missing.length;

  const mergedProperties: Record<string, unknown> = {};
  if (ownProperties) {
    for (const [name, sub] of Object.entries(ownProperties)) {
      safeSet(mergedProperties, name, sub);
    }
  }
  // The branch's OWN declaration of a name wins over the parent's — only names
  // it does not declare are copied down. `?? {}` because a hand-built (non-JSON)
  // schema can carry an explicitly `undefined` property value, which `hasOwn`
  // accepts but `JSON.stringify` drops on the wire — leaving a `required` naming
  // a property the provider never sees. The empty schema accepts anything, so it
  // is the neutral stand-in.
  for (const name of missing) {
    safeSet(mergedProperties, name, parentProperties[name] ?? {});
  }

  // Key order is deterministic — injected keys go in fixed positions around the
  // branch's existing keys — so a second pass, which finds both already present
  // and returns the branch untouched, produces the identical object.
  const out: Record<string, unknown> = {};
  if (!hasOwn(branch, "type")) out.type = "object";
  for (const [key, value] of Object.entries(branch)) {
    if (key === "properties") {
      out.properties = mergedProperties;
    } else if (key === "required" && unsatisfiable.size > 0) {
      const kept = branch.required.filter(
        (name): name is string =>
          typeof name === "string" && !unsatisfiable.has(name),
      );
      // An empty `required: []` is valid but noise; omit it, as transform #3 does.
      if (kept.length > 0) out.required = kept;
    } else {
      safeSet(out, key, value);
    }
  }
  if (!hasOwn(branch, "properties")) out.properties = mergedProperties;
  return out;
}

/**
 * Recurse into one element of an `allOf`/`anyOf`/`oneOf` array (transform #8).
 * Differs from `sanitizeSubschema` only in that the branch is told its parent's
 * property names, so its `required` resolves against the composition scope JSON
 * Schema actually gives it. `makeSelfSufficient` is set for the parameters ROOT
 * only (see the module header).
 */
function sanitizeCompositionBranch(
  branch: unknown,
  depth: number,
  parentProperties: Record<string, unknown> | null,
  budget: { remaining: number } | null,
): unknown {
  if (depth > MAX_DEPTH) return true;
  // Arrays and boolean/primitive schemas carry no `required` to resolve.
  if (!isPlainObject(branch)) return sanitizeSubschema(branch, depth);
  // A non-null budget marks a ROOT composition — the only place the
  // self-sufficiency repair applies, and the only place transform #1's nullable
  // rewrite stands down (see the module header).
  const sanitized = sanitizeSchemaNode(
    branch,
    depth,
    parentProperties,
    budget !== null,
  );
  return budget
    ? makeBranchSelfSufficient(sanitized, parentProperties, budget)
    : sanitized;
}

/**
 * Transform #1, nullable case: decide whether this node is a nullable single
 * type — `["string","null"]` and friends — that should be REWRITTEN to an
 * `anyOf` union instead of collapsed. Returns the non-null type name, or `null`
 * when the node keeps today's collapse.
 *
 * Order of the members does not matter and duplicates are tolerated
 * (`["null","string"]`, `["string","null","null"]`); what must hold is that
 * exactly one distinct non-`"null"` type is present, alongside at least one
 * `"null"`.
 *
 * Four shapes opt out, each for a measured or structural reason:
 *   - The ROOT and a branch of a ROOT composition (`isRootCompositionBranch`).
 *     The root must be an object for every provider, and a root union branch
 *     carrying its OWN `anyOf` is 0/3 on Grok — so rewriting there would turn a
 *     usable branch into one transform #9 rule (a) drops, taking the whole
 *     keyword (and with it every shape the union advertised) with it.
 *   - A sibling `enum`/`const` that excludes one of the two arms. These are
 *     AND-ed with `type`, so `{type:["string","null"], enum:["x"]}` means "must
 *     be \"x\"" and `{…, enum:[null]}` means "must be null". The rewrite moves
 *     the keyword onto the TYPED branch, leaving `{type:"null"}` unconstrained
 *     by it — so emitting the union would admit a value the node forbade. Both
 *     directions keep the collapse; `const: null` is the exception that still
 *     rewrites, because there the typed branch is unsatisfiable and the union
 *     reduces to "must be null", which is what the node says (collapsing it
 *     would give the unsatisfiable `{type:"string", const:null}` instead).
 *   - A COMPOSITION BRANCH whose `required` reaches the ENCLOSING node's
 *     `properties` — the extra scope transform #8 gives it. Moving such a name
 *     inside a nested `anyOf` puts it two levels from that scope, which is
 *     exactly the dangling `required` transform #3 exists to prevent on Gemini.
 *     A branch whose `required` is covered by its OWN `properties` needs no
 *     exception and is rewritten normally.
 */
function nullableUnionType(
  node: Record<string, unknown>,
  parentProperties: Record<string, unknown> | null | undefined,
  isRootCompositionBranch: boolean,
): string | null {
  if (isRootCompositionBranch) return null;
  const declared = node.type;
  if (!Array.isArray(declared)) return null;
  let typed: string | null = null;
  let sawNull = false;
  for (const member of declared) {
    if (typeof member !== "string") return null;
    if (member === "null") {
      sawNull = true;
      continue;
    }
    if (!NULLABLE_UNION_TYPES.has(member)) return null;
    if (typed !== null && typed !== member) return null;
    typed = member;
  }
  if (!sawNull || typed === null) return null;
  if (NULLABLE_REWRITE_BLOCKERS.some((key) => hasOwn(node, key))) return null;
  // A sibling `enum`/`const` is AND-ed with `type`, so it decides whether the
  // two arms the `type` array advertises are BOTH actually reachable — and the
  // rewrite may only emit an arm the input really allows. Moving the keyword
  // onto the typed branch leaves the `{type:"null"}` branch unconstrained by
  // it, so emitting that branch when the enum excludes `null` would admit a
  // value the author forbade (`{type:["string","null"], enum:["x"]}` means
  // "must be \"x\""), and emitting the typed branch when only `null` is allowed
  // would admit every string. Either way the union would say more than the node
  // did, so both keep the collapse.
  //
  // `const: null` is the one shape that still rewrites: the typed branch is
  // then unsatisfiable and the union reduces to "must be null", exactly what
  // the node means — where collapsing it would produce the unsatisfiable
  // `{type:"string", const:null}` instead, which is strictly worse.
  if (hasOwn(node, "const") && node.const !== null) return null;
  if (hasOwn(node, "enum")) {
    if (!Array.isArray(node.enum)) return null;
    const permitsNull = node.enum.some((member) => member === null);
    const permitsNonNull = node.enum.some((member) => member !== null);
    if (!permitsNull || !permitsNonNull) return null;
  }
  // Only a `required` name that actually REACHES the parent scope forces the
  // collapse. A branch whose `required` is satisfied by its own `properties`
  // loses nothing by being rewritten, and declining there would keep the
  // invented-value failure for a node that has no need of the exception. Key
  // names survive sanitization unchanged, so the raw map answers this.
  if (parentProperties != null && Array.isArray(node.required)) {
    const own = isPlainObject(node.properties) ? node.properties : null;
    const reachesParentScope = node.required.some(
      (name) => typeof name === "string" && !(own !== null && hasOwn(own, name)),
    );
    if (reachesParentScope) return null;
  }
  return typed;
}

/**
 * Build the typed branch of a nullable rewrite: the node's own type-bearing
 * keywords (`NULLABLE_BRANCH_KEYS`) under a scalar `type`, with `null` removed
 * from an `enum` because the sibling `{type:"null"}` branch already carries
 * that fact — and leaving it would make transform #2 emit a "May also be null."
 * note the schema no longer needs.
 *
 * The branch is run back through `sanitizeSchemaNode` rather than assembled by
 * hand so every per-node transform applies to it exactly as it would to any
 * scalar-typed node: transform #12 retypes it to `"object"` when it carries
 * `properties`, transform #13 drops an unsupported `pattern` into prose on the
 * branch, transform #3 resolves its `required` against its own `properties`,
 * and transform #2 filters its `enum`.
 *
 * Sanitized at THIS node's depth, not one deeper. The branch is a
 * re-expression of the node, so its children sit exactly where they sat before
 * the rewrite, and the depth budget they are charged is unchanged. No
 * `parentProperties` is passed: the only branch that could have used one — a
 * composition branch carrying `required` — is excluded by `nullableUnionType`.
 */
function buildNullableBranch(
  node: Record<string, unknown>,
  typeName: string,
  depth: number,
): Record<string, unknown> {
  const branch: Record<string, unknown> = { type: typeName };
  for (const [key, value] of Object.entries(node)) {
    if (!NULLABLE_BRANCH_KEYS.has(key)) continue;
    if (key === "enum" && Array.isArray(value)) {
      branch.enum = value.filter((member) => member !== null);
      continue;
    }
    safeSet(branch, key, value);
  }
  return sanitizeSchemaNode(branch, depth);
}

/**
 * @param parentProperties When this node is a composition branch, the enclosing
 *   node's SANITIZED `properties` map — the extra scope its `required` may name
 *   (transform #8). `undefined`/`null` for every other node, which keeps
 *   transform #3's own-properties-only rule exactly as it was.
 * @param isRootCompositionBranch True when this node is an element of a
 *   composition on the parameters ROOT. Only transform #1's nullable rewrite
 *   reads it, and only to decline: such a branch is judged individually by
 *   transform #9 rule (a), which rejects any branch carrying its own
 *   `anyOf`/`oneOf`.
 */
function sanitizeSchemaNode(
  node: Record<string, unknown>,
  depth: number,
  parentProperties?: Record<string, unknown> | null,
  isRootCompositionBranch = false,
): Record<string, unknown> {
  // Depth guard: stop walking absurdly nested input rather than overflowing
  // the stack. Real tool schemas are a few levels deep; anything past
  // MAX_DEPTH is adversarial, so the subtree is replaced with the
  // unconstrained empty schema instead of being carried through — passing it
  // through bounds only OUR recursion, and the bomb would then detonate in
  // `JSON.stringify` when the sanitized schema is serialized into the request.
  if (depth > MAX_DEPTH) return {};
  const childDepth = depth + 1;

  // Transform #1, nullable case. A NON-root `{type:["T","null"], …}` is emitted
  // as `anyOf: [<T branch>, {type:"null"}]` rather than collapsed to `T` with a
  // prose note, because prose loses to the schema: a model reading
  // `{type:"string", minLength:1}` cannot express "none" in the half of the
  // declaration it treats as binding, so it invents a value that satisfies the
  // type instead (see the module header). Decided first because everything
  // below — the `properties` pre-pass, the type resolution, the enum rule, the
  // notes — belongs to the BRANCH when the rewrite fires, not to the node that
  // now carries only the union and its annotations.
  const nullableType =
    depth > 0
      ? nullableUnionType(node, parentProperties, isRootCompositionBranch)
      : null;
  const nullableBranch =
    nullableType === null
      ? null
      : buildNullableBranch(node, nullableType, depth);

  // Sanitized `properties`, computed ahead of the key walk because transform #8
  // needs it before the walk reaches whichever of `properties` / `oneOf` comes
  // first in key order. Emitted verbatim when the walk reaches `properties`.
  // Skipped entirely under a nullable rewrite, where `properties` has moved
  // onto the typed branch and was sanitized there.
  const sanitizedProperties =
    nullableType === null && hasOwn(node, "properties")
      ? sanitizePropertiesKeyword(node.properties, childDepth)
      : undefined;
  const ownProperties = isPlainObject(sanitizedProperties)
    ? sanitizedProperties
    : null;

  // Property names a `required` on THIS node may reference — the node's OWN
  // `properties` (see module header: transform #3 matches Gemini's validator,
  // which does not resolve parent scope), PLUS, when this node is a composition
  // branch, the enclosing node's `properties` (transform #8: a branch of an
  // `allOf`/`anyOf`/`oneOf` IS evaluated against the enclosing node, so naming
  // its properties is correct JSON Schema, not a dangling reference).
  //
  // Probed against the two maps directly rather than unioned into a `Set`.
  // Building that set per node costs O(parent properties) for EVERY branch, so
  // a schema with P parent properties and B branches is O(P × B) — and both are
  // attacker-controlled for a third-party MCP `rawJsonSchema`. At P = B = 3000
  // that measured ~1.1s of synchronously blocked event loop, which is a denial
  // of service for every tenant on the process, not just the one whose
  // connector served the schema (the same hazard `flattenRootAllOf` guards
  // against below). Two `hasOwn` probes per `required` entry make it O(P + B).
  const declaresProperty = (name: string): boolean =>
    (ownProperties !== null && hasOwn(ownProperties, name)) ||
    (parentProperties != null && hasOwn(parentProperties, name));

  // Resolve the node's effective single `type`, collapsing a JSON Schema
  // `type` ARRAY (a MULTI-type union, e.g. `["string","number","boolean"]`) to
  // the first non-"null" member. Gemini's function-declaration schema requires
  // a single `type` and hard-rejects a type array, which manifests as a
  // misleading downstream error. Computed up front (not in key order) because
  // the `enum` decision below depends on it. The nullable case
  // (`["string","null"]`) took the `anyOf` rewrite above and never gets here —
  // except at the root and the two branch positions that decline it, which
  // collapse like any other union.
  const notesFromRetype: string[] = [];
  let typeToEmit: unknown = node.type;
  let emitType = "type" in node;
  let singleType: string | undefined;
  if (nullableType !== null) {
    // The `type` key's slot is taken by the `anyOf` emitted in the walk below,
    // so nothing resolves a scalar type here and no note is manufactured: the
    // union states the nullability the note used to approximate.
    emitType = false;
  } else if (Array.isArray(node.type)) {
    const nonNull = node.type.filter((t) => t !== "null");
    if (nonNull.length > 0) {
      typeToEmit = nonNull[0];
      if (typeof nonNull[0] === "string") singleType = nonNull[0];
    } else {
      emitType = false; // a `["null"]`-only type → drop it
    }
  } else if (typeof node.type === "string") {
    singleType = node.type;
  }
  // Transform #12: a node carrying `properties` IS an object, and Gemini
  // requires it to say so — "For schema with properties, schema type should be
  // OBJECT" on all of gemini-3.5/3.6/3.7-flash, both when the `type` is missing
  // and when it contradicts (`{type:"string", properties:{…}}` fails the same
  // way). Not composition-specific: a plain property subschema and an `items`
  // schema fail identically. xAI and OpenAI accept every one of those forms,
  // which is why it survived until a property sweep against live inference went
  // looking.
  //
  // Resolved HERE rather than patched onto the finished node so the rest of the
  // walk sees the real type: `dropEnum` below keys off it, and an `enum` left
  // behind on a node that has just become an object would be dropped by the
  // NEXT pass instead of this one — an idempotence break.
  const retypedFromProperties =
    isPlainObject(sanitizedProperties) && singleType !== "object";
  if (retypedFromProperties) {
    if (singleType !== undefined) {
      // A contradictory declared type is discarded; record it like transform #1
      // records a collapsed union.
      notesFromRetype.push(
        `Declared as ${singleType}, but carries properties, so it is treated as an object.`,
      );
    }
    typeToEmit = "object";
    emitType = true;
    singleType = "object";
  }
  // Gemini accepts `enum` only on string-typed properties. Drop it outright
  // when the node has an explicit NON-string type (boolean/number/integer/
  // array/object/null); when the type is "string" or absent, the enum is
  // instead filtered to its string members below. (The constraint is advisory
  // — arguments are validated at dispatch and by the remote server.)
  const dropEnum = singleType !== undefined && singleType !== "string";

  // A `type` collapse or a dropped `enum` discards a constraint the model
  // could use. Fold that information into the node's `description` (as prose,
  // which every provider accepts) so the model still sees it. Computed up
  // front so it can be appended wherever `description` appears in key order.
  const notes: string[] = [...notesFromRetype];
  if (nullableType === null && Array.isArray(node.type)) {
    const typeNames = node.type.filter((t): t is string => typeof t === "string");
    if (typeNames.length > 1) {
      notes.push(`Accepts ${humanJoin(typeNames)}.`);
    } else if (typeNames.length === 1 && typeNames[0] === "null") {
      // A `["null"]`-only type was dropped (no scalar type to emit).
      notes.push("Must be null.");
    }
  }
  if (nullableType === null && Array.isArray(node.enum)) {
    const stringMembers = node.enum.filter((v) => typeof v === "string");
    if (dropEnum || stringMembers.length === 0) {
      // The whole enum is dropped (non-string type, or no string members
      // survive the string-filter) — surface every original allowed value.
      notes.push(
        `Allowed values: ${node.enum.map(describeEnumValue).join(", ")}.`,
      );
    } else if (node.enum.length > stringMembers.length) {
      // Partial filter: string members are kept in the emitted `enum`; surface
      // the dropped non-string members so they aren't lost.
      const dropped = node.enum.filter((v) => typeof v !== "string");
      notes.push(`May also be ${humanJoin(dropped.map(describeEnumValue))}.`);
    }
  }
  // Transform #13, decided up front so its note joins the others before
  // `descNote` is frozen and the loop below can simply skip the keyword.
  const dropPattern =
    nullableType === null &&
    typeof node.pattern === "string" &&
    usesUnsupportedRegexConstruct(node.pattern);
  if (dropPattern) {
    const pattern = node.pattern as string;
    const shown =
      pattern.length > MAX_PATTERN_IN_PROSE
        ? `${pattern.slice(0, MAX_PATTERN_IN_PROSE)}…`
        : pattern;
    notes.push(`Should match the pattern ${shown}.`);
  }

  const descNote = notes.join(" ");
  let descriptionEmitted = false;

  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(node)) {
    if (METADATA_KEYS.has(key)) continue;
    // Never let an invalid `__proto__`/`constructor`/`prototype` *keyword*
    // through; none are valid JSON Schema keywords. (Literal property names
    // by those names are handled safely inside `sanitizeSchemaMap`.)
    if (PROTO_KEYS.has(key)) continue;

    // Transform #1, nullable case: every type-bearing keyword has moved onto
    // the typed branch, which was sanitized as a node in its own right. Only
    // the node's annotations (and any keyword outside both sets) stay here.
    if (nullableType !== null && NULLABLE_BRANCH_KEYS.has(key)) continue;

    if (key === "type") {
      if (nullableBranch !== null) {
        // Emitted in the `type` key's own position so key order stays
        // deterministic — which is what lets a second pass, finding an `anyOf`
        // it leaves alone, reproduce this object exactly.
        out.anyOf = [nullableBranch, { type: "null" }];
        continue;
      }
      if (emitType) out.type = typeToEmit;
      continue;
    }

    if (key === "description") {
      // Append any constraint notes (collapsed type / dropped enum) to the
      // existing description so the information survives the sanitization.
      descriptionEmitted = true;
      out.description =
        typeof value === "string" && descNote
          ? `${value} ${descNote}`
          : value;
      continue;
    }

    if (key === "enum") {
      // Gemini accepts `enum` ONLY as a list of strings: an enum on a
      // boolean/number/integer type is rejected (`dropEnum`), and even on a
      // string type any non-string member is rejected — including leftovers
      // after a union `type` was collapsed to "string" (e.g. `type:
      // ["string","number"], enum: ["a", 1]` → keep only `["a"]`). Filter to
      // string members; drop the keyword entirely if none remain. (Verified
      // against live Gemini inference.)
      if (!dropEnum && Array.isArray(value)) {
        const strings = value.filter((v): v is string => typeof v === "string");
        if (strings.length > 0) out.enum = strings;
      }
      continue;
    }

    if (key === "required") {
      if (Array.isArray(value)) {
        const pruned = value.filter(
          (name): name is string =>
            typeof name === "string" && declaresProperty(name),
        );
        // An empty `required: []` is valid but noise; omit it entirely.
        if (pruned.length > 0) out.required = pruned;
      }
      // A non-array `required` is malformed JSON Schema (and would itself
      // trip a strict validator) — drop it.
      continue;
    }

    if (key === "pattern") {
      // Transform #13: a regex construct some provider refuses takes the WHOLE
      // request down, so the pattern is dropped and echoed as prose instead —
      // the model still sees the intent, and arguments are validated at
      // dispatch and by the remote server regardless. A supported pattern is a
      // real constraint every provider honours and is kept verbatim.
      if (dropPattern) continue;
      out.pattern = value;
      continue;
    }

    if (key === "dependencies") {
      // draft-07: name → (subschema | string[]). Subschema values are
      // sanitized (and self-prune their own `required`); string[] values are
      // property dependencies (opaque data), left untouched.
      if (isPlainObject(value)) {
        const deps: Record<string, unknown> = {};
        for (const [name, dep] of Object.entries(value)) {
          safeSet(
            deps,
            name,
            isPlainObject(dep) ? sanitizeSchemaNode(dep, childDepth) : dep,
          );
        }
        out.dependencies = deps;
      } else {
        out.dependencies = value;
      }
      continue;
    }

    if (key === "properties") {
      // Already sanitized (with transform #7 applied) ahead of this walk, since
      // transform #8 below may need it first. Emit it in its original position.
      out.properties = sanitizedProperties;
      continue;
    }

    if (SUBSCHEMA_MAP_KEYS.has(key)) {
      out[key] = sanitizeSchemaMap(value, childDepth);
      continue;
    }

    if (key === "additionalProperties") {
      // Drop the boolean `false` form — xAI (Grok) rejects it on a nested
      // object schema and 400s the whole request (transform #6). `true` (no-op
      // default) and an object-valued subschema (a real constraint) are kept;
      // the latter is recursed into like any other single subschema.
      if (value === false) continue;
      out.additionalProperties = sanitizeSubschema(value, childDepth);
      continue;
    }

    if (SUBSCHEMA_SINGLE_KEYS.has(key) || key === "items") {
      // `items` is a subschema (2020-12) or an array of subschemas (draft-07
      // tuple); `sanitizeSubschema` handles both.
      out[key] = sanitizeSubschema(value, childDepth);
      continue;
    }

    if (COMPOSITION_KEYS.has(key)) {
      // Transform #10: an EMPTY array-valued keyword is a hard 400 on xAI at
      // any depth — `/properties/a/oneOf: [] has less than 1 item` — for all
      // three composition keywords and for `prefixItems` below. It carries no
      // constraint anyway (an `allOf` of nothing is satisfied by everything), so
      // it is omitted rather than emitted. Empty OBJECTS (`properties: {}`,
      // `$defs: {}`) and an empty `required: []` are accepted and unaffected.
      if (Array.isArray(value) && value.length === 0) continue;
      // Transform #8: each element is evaluated against THIS node, so it is
      // handed this node's property scope. The self-sufficiency repair is
      // applied at the parameters root only (`depth === 0`) — nested
      // compositions are accepted as-is by every measured provider.
      // One budget per root composition keyword, shared across its branches so
      // the ceiling bounds the TOTAL copy-down, not each branch individually.
      const budget = depth === 0 ? { remaining: MAX_ROOT_COPY_DOWN } : null;
      out[key] = Array.isArray(value)
        ? value.map((v) =>
            sanitizeCompositionBranch(v, childDepth, ownProperties, budget),
          )
        : value;
      continue;
    }

    if (SUBSCHEMA_ARRAY_KEYS.has(key)) {
      // `prefixItems: []` — same empty-array rejection as the compositions above.
      if (Array.isArray(value) && value.length === 0) continue;
      out[key] = Array.isArray(value)
        ? value.map((v) => sanitizeSubschema(v, childDepth))
        : value;
      continue;
    }

    // Opaque keyword (`default`, `examples`, `format`, `pattern`,
    // `dependentRequired`, numeric bounds, …) — copy verbatim. Notably we do
    // NOT walk into `default`/`examples` values, which are arbitrary data and
    // may legitimately contain `properties`/`required` keys that are not
    // schema structure.
    safeSet(out, key, value);
  }

  // If we have constraint notes but the node had no `description` to append
  // them to, add one so the dropped information still reaches the model.
  if (descNote && !descriptionEmitted) out.description = descNote;

  // Transform #12, emission half. A node that DECLARED a `type` had it rewritten
  // in the key loop above; one that declared none needs the key appended, since
  // the loop only ever emits keys the node actually had.
  if (retypedFromProperties && !hasOwn(node, "type")) out.type = "object";

  return out;
}

/**
 * Keys an `allOf` branch may carry and still be merged losslessly into a single
 * object schema: plain object structure plus annotations. A branch with any
 * other keyword (`$ref`, `not`, `if`/`then`/`else`, `anyOf`/`oneOf`, nested
 * `allOf`, `dependentSchemas`/`dependencies`, `patternProperties`,
 * `propertyNames`, `unevaluatedProperties`, …) carries a constraint the flatten
 * does NOT carry forward, so flattening it would silently drop that constraint.
 */
const MERGEABLE_ALLOF_BRANCH_KEYS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "description",
  "title",
]);

/** Sibling keywords on the root that, alongside `allOf`, mean the root is not a
 * pure intersection — flattening only the `allOf` would change its meaning. */
const ROOT_COMPOSITION_SIBLINGS = [
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "$ref",
];

/** True if every `allOf` branch is a plain object schema whose keywords are all
 * merge-safe (and whose `type`, if present, is `"object"`; whose
 * `additionalProperties`, if present, is `true` — the only boolean surviving
 * transform #6; an object-valued form blocks the flatten) — i.e. the
 * intersection can be flattened without dropping any constraint. */
function canLosslesslyFlattenAllOf(
  root: Record<string, unknown>,
  branches: unknown[],
): boolean {
  if (ROOT_COMPOSITION_SIBLINGS.some((k) => k in root)) return false;
  for (const branch of branches) {
    if (!isPlainObject(branch)) return false;
    for (const key of Object.keys(branch)) {
      if (!MERGEABLE_ALLOF_BRANCH_KEYS.has(key)) return false;
    }
    if ("type" in branch && branch.type !== "object") return false;
    if (
      "additionalProperties" in branch &&
      typeof branch.additionalProperties !== "boolean"
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Flatten a top-level `allOf` of object subschemas into a single object schema
 * (see module-header transform #5). Operates ONLY on the parameters root —
 * `allOf` nested deeper is a meaningful constraint left intact by the walk. The
 * root node and every `allOf` branch contribute their `properties` (a later
 * branch wins a key collision) and `required` entries (unioned, then pruned to
 * the merged property set). The node walk runs BEFORE this flatten and has
 * already dropped every boolean `additionalProperties: false` (transform #6),
 * so only `true` can reach the merge — it is carried through and the flattened
 * root never emits `false`. Branch-level `description`s are folded into the
 * merged description rather than dropped.
 *
 * The flatten is applied ONLY when every branch can be merged losslessly
 * (`canLosslesslyFlattenAllOf`): a branch carrying a keyword the merge doesn't
 * carry forward — `$ref`, `not`, `if`, nested composition, `dependentSchemas`,
 * `patternProperties`, … — or a non-object `type`, or a schema-valued
 * `additionalProperties`, leaves the `allOf` UNTOUCHED. Dropping such a branch
 * would advertise an empty/under-constrained object to the model (it runs on
 * every third-party MCP `rawJsonSchema`), so we keep the original composition
 * rather than silently lose the constraint. A no-op when the root has no
 * `allOf` array.
 */
function flattenRootAllOf(
  root: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(root.allOf)) return root;
  // Only flatten when nothing is lost; otherwise keep the composition intact.
  if (!canLosslesslyFlattenAllOf(root, root.allOf)) return root;

  const mergedProps: Record<string, unknown> = {};
  const requiredSet = new Set<string>();
  // Transform #6 already stripped every boolean `additionalProperties: false`
  // during the node walk, so the only boolean that can reach here is `true`
  // (the no-op default). Carry it through if any branch declares it; we never
  // (re)introduce a `false` the providers downstream would reject.
  let additionalProperties: true | undefined;
  // Branch-level `description`s are folded into the merged description rather
  // than dropped (a branch may carry input-semantics context for the model).
  const branchDescriptions: string[] = [];

  // The root's own object fields merge first, then each allOf branch in order.
  const branches = [root, ...root.allOf];
  for (const branch of branches) {
    if (!isPlainObject(branch)) continue;
    if (isPlainObject(branch.properties)) {
      for (const [name, sub] of Object.entries(branch.properties)) {
        safeSet(mergedProps, name, sub);
      }
    }
    if (Array.isArray(branch.required)) {
      for (const name of branch.required) {
        if (typeof name === "string") requiredSet.add(name);
      }
    }
    // Only `true` survives the node walk (transform #6 dropped `false`); carry
    // it. An object-valued form would have blocked the flatten entirely
    // (canLosslesslyFlattenAllOf), so it can't appear here.
    if (branch.additionalProperties === true) additionalProperties = true;
    // Collect branch descriptions other than the root's own (handled below).
    if (branch !== root && typeof branch.description === "string") {
      branchDescriptions.push(branch.description);
    }
  }

  // Preserve root-level annotations (e.g. `description`, `$id`) while dropping
  // the composition keyword and any root object fields now folded into the
  // merged result.
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(root)) {
    if (
      key === "allOf" ||
      key === "properties" ||
      key === "required" ||
      key === "type" ||
      key === "additionalProperties"
    ) {
      continue;
    }
    safeSet(out, key, value);
  }
  out.type = "object";
  out.properties = mergedProps;
  // Fold branch descriptions into the merged description (root's first), keeping
  // only those not already present so a duplicated annotation isn't repeated.
  const descriptions = [
    ...(typeof out.description === "string" ? [out.description] : []),
    ...branchDescriptions,
  ];
  // `Set`, not `filter`+`indexOf`: the latter is O(n²), and `allOf` branch
  // count is attacker-controlled for an MCP tool schema — 40k branches cost
  // ~1.9s of blocked event loop, which is a denial of service for every tenant
  // on the process, not just the one whose connector served the schema.
  // Insertion order is preserved either way, so the output is unchanged.
  const uniqueDescriptions = [...new Set(descriptions)];
  if (uniqueDescriptions.length > 0) out.description = uniqueDescriptions.join(" ");
  // `hasOwn`, not `name in mergedProps`: the latter would treat a required
  // entry named after a prototype member ("toString", "constructor") as present
  // and fail to prune a genuinely-undeclared property.
  const required = [...requiredSet].filter((name) => hasOwn(mergedProps, name));
  if (required.length > 0) out.required = required;
  if (additionalProperties !== undefined) {
    out.additionalProperties = additionalProperties;
  }
  return out;
}

/** The two composition keywords whose ROOT branches xAI validates individually.
 * `allOf` is deliberately absent: measured, its branches are unconstrained (a
 * `$ref`, `not`, nested-`allOf` or scalar branch all pass) — for `allOf` it is
 * the ROOT's own object-ness that matters, which is the second half of
 * transform #9. */
const ROOT_UNION_KEYS = ["anyOf", "oneOf"] as const;

/**
 * True if a sanitized branch of a ROOT `anyOf`/`oneOf` is one xAI accepts.
 * Measured on grok-4.3/4.5/4.6: `{type:"object", properties:…, required:…}`,
 * `{properties:…, required:…}` and `{type:"object", required:…}` all pass —
 * `type: "object"` OR `properties`, either alone, suffices — while a bare
 * `{required:[…]}`, a `{}`, and a `{type:"string"}` are a 400 that fails every
 * tool in the request. The rule holds even when the root itself declares
 * `type: "object"` and `properties`, so an object root does not excuse a
 * non-object branch.
 */
function isUsableRootBranch(branch: unknown): boolean {
  if (!isPlainObject(branch)) return false;
  if (Object.keys(branch).length === 0) return false;
  // A branch carrying its OWN `anyOf`/`oneOf` is unusable however object-shaped
  // it otherwise looks: `{type:"object", anyOf:[…]}` as a root union branch is
  // 0/3 on grok-4.3/4.5/4.6 (and a branch carrying BOTH `allOf` and `anyOf` is
  // 0/3 too — the union is what poisons it), while every Gemini and GPT model
  // accepts it. The `type` is not the problem, so the checks below never see it.
  //
  // This is NOT the recursion that was rejected earlier. Making such a branch
  // *usable* is impossible — that was the right call. But "cannot be made
  // usable" means it must be REPORTED unusable, which routes it into the drop
  // path that already handles the other unrepairable branch shapes correctly.
  //
  // Scope is the branch's OWN keys, never its subtree. A composition on a
  // branch's PROPERTY is accepted 9/9 (`{type:"object", properties:{a:{anyOf:
  // […]}}}`), as is one two levels down, so a subtree scan would destroy
  // constraints every provider honours. `ROOT_UNION_KEYS`, not
  // `COMPOSITION_KEYS`: a branch's own `allOf` is accepted 9/9 — including with
  // a bare-`required` sub-branch — which is the same intersection-vs-union
  // asymmetry xAI applies to the root itself.
  if (ROOT_UNION_KEYS.some((key) => hasOwn(branch, key))) return false;
  // A `$ref` disqualifies a branch too, and NOT only when it stands alone:
  // `{$ref, type:"object"}` and `{$ref, properties}` are both 0/3 on
  // grok-4.3/4.5/4.6 (accepted by Gemini and OpenAI). xAI does not resolve a
  // union branch's `$ref` at all, so sibling object keywords do not redeem it.
  // Transform #14 gets first refusal on these — it inlines the target and keeps
  // the siblings — so only an un-inlinable one reaches the drop.
  if (hasOwn(branch, "$ref")) return false;
  // A declared `type` decides on its own: `properties` alongside an explicit
  // NON-object type is a self-contradictory branch (object keywords on a
  // non-object schema), and measured, xAI rejects it exactly as it rejects a
  // bare `{type:"string"}` — `{type:"string", properties:{…}, required:[…]}` is
  // 0/3 on grok-4.3/4.5/4.6 while the same branch without the `type` is 3/3. So
  // `properties` suffices only when the branch declares no type at all.
  // (Transform #1 has already collapsed any `type` ARRAY to a scalar by now.)
  if (hasOwn(branch, "type")) return branch.type === "object";
  return isPlainObject(branch.properties);
}

/**
 * True if the sanitized root reads as an object root to xAI, which rejects a
 * parameters root that is not one. Measured: `{type:"object", …}` and
 * `{properties:…}` pass, an entirely empty `{}` passes, and a union root whose
 * branches are all object-carrying passes (xAI infers object-ness from the
 * branches) — but a root carrying only `$defs`, or only an `allOf`, is a 400.
 */
function isObjectRoot(root: Record<string, unknown>): boolean {
  // A declared `type` decides first, and it is the strictest rule measured
  // anywhere in this module: a root whose `type` is not "object" is rejected by
  // grok-4.3/4.5/4.6, gpt-5.6-sol AND gemini-3.7-flash — 0/5 — with or without
  // a `properties` map alongside it. Every other root rule has at least one
  // tolerant provider; this one has none.
  if (hasOwn(root, "type")) return root.type === "object";
  if (isPlainObject(root.properties)) return true;
  if (Object.keys(root).length === 0) return true;
  // Only ever called after `dropUnusableRootUnions`, so a union still present
  // here is one whose branches are all usable.
  return ROOT_UNION_KEYS.some(
    (key) => Array.isArray(root[key]) && (root[key] as unknown[]).length > 0,
  );
}

/**
 * Transform #9 — the root-usability pass (see the module header). Two rules,
 * both measured against grok-4.3/4.5/4.6 through OpenRouter with
 * `provider.allow_fallbacks: false` and one tool per request:
 *
 *  a. A branch of a root `anyOf`/`oneOf` that transform #8 could not make
 *     object-carrying cannot be repaired at all — its `required` names something
 *     no `properties` map declares, or it is a `$ref`/scalar/boolean branch. Drop
 *     the whole keyword rather than emit a root that 400s every tool in the
 *     request: losing one tool's constraint beats losing every tool. (An empty
 *     composition array constrains nothing and goes the same way.)
 *  b. A composition root that declares neither `type` nor `properties` is
 *     rejected on its own account, whatever its branches look like — `{allOf:
 *     [{$ref:…}]}` and `{allOf:[…, {not:…}]}` are 0/3 on Grok. Adding
 *     `type: "object"` makes exactly those roots pass (9/9) while changing
 *     nothing about the composition, so the un-flattenable `allOf` that
 *     transform #5 deliberately preserves is rescued rather than discarded.
 *     Nothing is added when the root already declares a `type`.
 *
 * Applies to the parameters root only — no provider constrains a nested
 * composition, and every measured model accepts the nested forms handled here.
 * Runs after `flattenRootAllOf`, so a root `allOf` that flattened losslessly is
 * already gone and only an un-flattenable one reaches rule (b).
 */
/**
 * Transform #14: inline a ROOT union branch that is a local `$ref`, so the union
 * survives rule (a) instead of being dropped whole.
 *
 * `z.union([A, B])` renders as `{anyOf: [{$ref}, {$ref}], $defs}`, and xAI does
 * not resolve a `$ref` union branch — 0/3 even with `type: "object"` on the
 * root. Rule (a) therefore dropped the keyword and, with the properties living
 * in `$defs`, the tool was left advertising no parameters at all. Inlining the
 * target makes the branch an ordinary object branch, which is accepted 9/9, and
 * keeps the constraint the union was expressing.
 *
 * Only branches that are NOT already usable are inlined, so a well-formed union
 * is untouched and the emitted schema does not grow for no reason. One level
 * only: a `$ref` inside the inlined target is left to resolve on its own, which
 * is both what providers accept and what makes a recursive definition
 * terminate here rather than loop. Sibling keywords on the branch are kept and
 * win over the target's, matching 2020-12 `$ref` semantics. The branch count is
 * capped for the same reason the copy-down is — both counts are
 * attacker-controlled, and the inlined objects are shared references that expand
 * on `JSON.stringify`.
 */
function inlineRootUnionRefs(
  root: Record<string, unknown>,
): Record<string, unknown> {
  let changed = false;
  const out: Record<string, unknown> = {};
  // ONE budget for the whole root, not one per keyword: a root carrying both an
  // `anyOf` and a `oneOf` would otherwise get twice the ceiling, which
  // contradicts the "single ceiling across one root composition" invariant that
  // transform #8's copy-down also states.
  let budget = MAX_ROOT_COPY_DOWN;

  for (const [key, value] of Object.entries(root)) {
    if (!(ROOT_UNION_KEYS as readonly string[]).includes(key) || !Array.isArray(value)) {
      safeSet(out, key, value);
      continue;
    }
    const branches = value.map((branch) => {
      if (isUsableRootBranch(branch)) return branch;
      if (!isPlainObject(branch) || typeof branch.$ref !== "string") return branch;
      const ref = branch.$ref;
      if (ref !== "#" && !ref.startsWith("#/")) return branch;
      const target = resolveLocalPointer(root, ref);
      // A self-referential root pointer would inline the whole document into
      // one of its own branches; nothing useful, and unbounded.
      if (!isPlainObject(target) || target === root) return branch;
      // Priced by EXPANDED size — the whole subtree that will be duplicated
      // into the request body — not by the target's top-level key count.
      const size = subtreeWeight(target, budget);
      if (size > budget) return branch;
      budget -= size;

      const inlined: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(target)) safeSet(inlined, k, v);
      for (const [k, v] of Object.entries(branch)) {
        if (k === "$ref") continue;
        safeSet(inlined, k, v);
      }
      changed = true;
      return inlined;
    });
    out[key] = branches;
  }

  return changed ? out : root;
}

function dropUnusableRootUnions(
  root: Record<string, unknown>,
): Record<string, unknown> {
  // All-or-nothing, and deliberately so. ONE unusable branch poisons the whole
  // keyword on xAI — `{type:"object", properties:{…}, oneOf:[{type:"object",
  // required:[…]}, {type:"string"}]}` is 0/3 on Grok despite the first branch
  // being perfectly good — so a mixed union cannot simply be left alone.
  //
  // Filtering the bad branches out instead of dropping the keyword IS accepted
  // (a lone surviving usable branch measures 3/3), and it is not what we do:
  // filtering ADVERTISES A NARROWER TOOL. `oneOf: [A, B]` filtered to
  // `oneOf: [A]` tells the model the B-shaped call is invalid, so it will never
  // make one, and nothing surfaces that the arm went missing. Dropping the
  // keyword instead leaves the parent's `properties` fully visible: the model
  // can still call the tool either way, and a wrong COMBINATION is caught at
  // dispatch by the zod schema and by the remote MCP server, where it comes back
  // as a recoverable tool error the model can retry. That matches every other
  // transform here — they discard advisory constraints, never callable shapes.
  const dropped = new Set<string>();
  for (const key of ROOT_UNION_KEYS) {
    const branches = root[key];
    if (!Array.isArray(branches)) continue;
    if (branches.length === 0 || !branches.every(isUsableRootBranch)) {
      dropped.add(key);
    }
  }
  if (dropped.size === 0) return root;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(root)) {
    if (dropped.has(key)) continue;
    safeSet(out, key, value);
  }
  return out;
}

/**
 * Keywords that make xAI classify the parameters ROOT as something other than an
 * object schema, whatever else it declares. Measured on grok-4.5: a root
 * carrying `const` is `root schema is a const` and a root carrying `$ref` is
 * `root schema is a $ref` — both 400, both even when the root also declares
 * `type: "object"` AND `properties`, and the `$ref` case even when the target
 * resolves. Neither can describe a callable argument object, so both are dropped
 * at the root and their information folded into the description. Nested `const`
 * and `$ref` are meaningful and untouched.
 */
const ROOT_REJECTED_KEYWORDS = ["const", "$ref"] as const;

/**
 * Transform #9, rule (b). Runs AFTER `flattenRootAllOf`, so a root `allOf` that
 * merged losslessly is already gone and only a composition that survived — or a
 * root left bare by rule (a) — reaches this check. Applies to EVERY root, not
 * just composition roots.
 */
function ensureObjectRoot(
  root: Record<string, unknown>,
): Record<string, unknown> {
  const rejected = ROOT_REJECTED_KEYWORDS.filter((key) => hasOwn(root, key));
  if (rejected.length > 0) {
    const stripped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(root)) {
      if ((rejected as readonly string[]).includes(key)) continue;
      safeSet(stripped, key, value);
    }
    const note = rejected
      .map((key) =>
        key === "const"
          ? `Pinned to a single value (${describeEnumValue(root.const)}) at the schema root.`
          : `Declared as a reference (${describeEnumValue(root.$ref)}) at the schema root.`,
      )
      .join(" ");
    stripped.description =
      typeof stripped.description === "string" && stripped.description.length > 0
        ? `${stripped.description} ${note}`
        : note;
    return ensureObjectRoot(stripped);
  }

  if (isObjectRoot(root)) return root;

  // Applies to EVERY root, not just composition roots. A property-based sweep
  // over recursive schema shapes found the narrower gate emitting unusable
  // roots for whole classes the example fixtures never covered: a scalar or
  // array root (`{type:"string"}`, reachable from transform #1 collapsing
  // `{type:["string","null"]}`), an annotation-only root (`{description}`), a
  // `$defs`-only root, and a root whose `type` contradicts its `properties`.
  // Measured, all of them fail Grok, the scalar ones also fail gpt-5.6-sol, and
  // the contradictory-type one fails all nine. `{type:"object"}` plus whatever
  // else the root carried is accepted 9/9 in every case.
  //
  // Forcing `type: "object"` over a declared scalar type is a rewrite, not a
  // repair, and it is the right one: function-call arguments are always a named
  // object on the wire, so a scalar parameters root cannot describe a callable
  // tool no matter which provider reads it. Sibling keywords are left as they
  // are — an `items` stranded on an object root is inert, and every model
  // accepts it, so removing it would be surgery with no measured benefit.
  const declaredType = typeof root.type === "string" ? root.type : undefined;
  const notes: string[] = [];

  const out: Record<string, unknown> = { type: "object" };
  for (const [key, value] of Object.entries(root)) {
    if (key === "type") continue;
    // `enum` is the ONE keyword whose treatment depends on the node's type
    // (transform #2 accepts it only on a string-typed or type-less node), so
    // retyping the root to "object" while keeping it would leave a root the
    // node walk would sanitize differently on a second pass — i.e. break
    // idempotence, which the property sweep catches immediately. Drop it here
    // and surface the values as prose, exactly as transform #2 does.
    if (key === "enum") {
      if (Array.isArray(value) && value.length > 0) {
        notes.push(`Allowed values: ${value.map(describeEnumValue).join(", ")}.`);
      }
      continue;
    }
    safeSet(out, key, value);
  }

  if (declaredType !== undefined) {
    // Fold the discarded type into the description, as transforms #1 and #2 do
    // for the constraints they drop.
    notes.push(
      `Declared as ${declaredType} at the schema root; arguments are passed as an object.`,
    );
  }
  // `enum` is dropped above whenever the root is retyped, INCLUDING when it
  // declared no type at all (`{enum:["a"]}`). Keying that on a declared scalar
  // type left an `enum` sitting on a now-object root, which the next pass would
  // drop under transform #2 — an idempotence break the generator never reached
  // because it emitted no type-less `enum` root.
  if (notes.length > 0) {
    const note = notes.join(" ");
    out.description =
      typeof out.description === "string" && out.description.length > 0
        ? `${out.description} ${note}`
        : note;
  }
  return out;
}

/**
 * Resolve a local JSON Pointer (`#/a/b`) against the document root, returning
 * `undefined` when any segment is missing. Segment unescaping is the RFC 6901
 * order — `~1` before `~0` — because doing it the other way turns a literal
 * `~01` into `/` instead of `~1`.
 */
function resolveLocalPointer(root: Record<string, unknown>, ref: string): unknown {
  if (ref === "#") return root;
  const path = ref.slice(2);
  // `#/` and `#//`-style paths carry no real segments; RFC 6901 makes an empty
  // path the document root, and treating "" as a property name would prune a
  // reference that is technically valid.
  if (path === "") return root;
  const segments = path.split("/");
  let current: unknown = root;
  for (const raw of segments) {
    // A `$ref` is a URI, so its fragment is percent-encoded: `#/$defs/a%20b`
    // addresses the key `"a b"`. Decode that layer FIRST, then the pointer
    // layer's `~1`/`~0`. Skipping the decode strips a perfectly valid reference
    // as unresolvable and silently loses the constraint it carried. A malformed
    // escape (`%zz`) throws, and the raw text is the right fallback there.
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      decoded = raw;
    }
    const segment = decoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (!isPlainObject(current) || !hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Transform #11: drop a `$ref` whose LOCAL target does not resolve.
 *
 * xAI resolves `#/...` pointers itself and 400s the whole request when one
 * dangles — `unresolvable $ref '#/$defs/Nope': key 'Nope' not found under
 * '#/$defs'`, and `key '$defs' not found in schema` when the document has no
 * `$defs` at all. This is easy to produce in practice: a third-party MCP server
 * that ships a subschema without its definitions, or one whose `$defs` sits on a
 * nested node (a `#/$defs/X` pointer is anchored at the document ROOT, so a
 * nested `$defs` is genuinely unaddressable that way).
 *
 * Only local pointers are checked. An external `$ref` (`https://…`) is accepted
 * by xAI and left alone, as is a resolvable non-`$defs` pointer such as
 * `#/properties/a` — both measured. Dropping only the `$ref` keyword leaves the
 * rest of the node intact; a node that was nothing but a dangling `$ref` becomes
 * the unconstrained `{}`, which every model accepts. This runs after the node
 * walk, so it resolves against the SANITIZED document — the one actually sent.
 */
function pruneUnresolvableRefs(
  node: unknown,
  root: Record<string, unknown>,
  depth: number,
  state: { changed: boolean } = { changed: false },
): unknown {
  // `{}` rather than `true`, matching `sanitizeSchemaNode`'s guard: a boolean
  // schema is not a plain object, so `canLosslesslyFlattenAllOf` would refuse a
  // branch it would otherwise merge.
  if (depth > MAX_DEPTH) return {};
  if (Array.isArray(node)) {
    return node.map((item) => pruneUnresolvableRefs(item, root, depth + 1, state));
  }
  if (!isPlainObject(node)) return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (
      key === "$ref" &&
      typeof value === "string" &&
      (value === "#" || value.startsWith("#/")) &&
      resolveLocalPointer(root, value) === undefined
    ) {
      state.changed = true;
      continue;
    }
    // Opaque data keywords may legitimately contain a `$ref`-named key that is
    // not a reference (the walk treats them as data for the same reason), so
    // they are copied rather than descended into.
    if (key === "enum" || key === "const" || key === "default" || key === "examples") {
      safeSet(out, key, value);
      continue;
    }
    safeSet(out, key, pruneUnresolvableRefs(value, root, depth + 1, state));
  }
  return out;
}

/** Prune against `root`, returning the ORIGINAL reference when nothing was
 *  dropped so the pipeline can detect a fixed point without a deep compare
 *  (this module deliberately never hands an untrusted value to
 *  `JSON.stringify`, whose own recursion would outrun the depth guard). */
function prunedOrSame(root: Record<string, unknown>): Record<string, unknown> {
  const state = { changed: false };
  const pruned = pruneUnresolvableRefs(root, root, 0, state);
  if (!state.changed) return root;
  return isPlainObject(pruned) ? pruned : {};
}

/**
 * Return a sanitized, non-mutating copy of a tool parameter JSON Schema (see
 * the module header for the immutability caveat — opaque leaf values are
 * shared by reference, so treat the result as read-only). A non-object root
 * (boolean schema, or malformed third-party payload) yields an empty object
 * rather than throwing.
 *
 * Idempotent: `sanitizeToolSchema(sanitizeToolSchema(x))` deep-equals
 * `sanitizeToolSchema(x)`. Transform #8's copy-down depends on that — a repaired
 * branch that a second pass re-emptied would be no repair at all.
 */
export function sanitizeToolSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (!isPlainObject(schema)) return {};
  const walked = sanitizeSchemaNode(schema, 0);
  // Rule (a) runs BEFORE the flatten, not after. `canLosslesslyFlattenAllOf`
  // refuses to merge an `allOf` while a `oneOf`/`anyOf` sibling is present (the
  // root is then not a pure intersection) — so dropping an unusable union
  // afterwards would leave behind an `allOf` that the NEXT pass would flatten,
  // breaking idempotence. Removing the union first makes the root a genuine
  // intersection, which is exactly when flattening it is correct.
  // The root passes are run to a FIXED POINT rather than once.
  //
  // Ordering alone cannot satisfy both constraints. Transform #11 has to run
  // BEFORE the flatten, because dropping a dangling `$ref` can empty the node
  // that carried it and an emptied `allOf` branch is merge-safe — pruning after
  // would strand a composition for the NEXT pass to merge. But it also has to
  // run AFTER the root rewrites, because those remove root keywords a nested
  // `$ref` may point at: `{properties:{x:{$ref:"#/const"}}, const:{}}` loses its
  // `const` to transform #9 and is left with exactly the dangling reference #11
  // exists to prevent, and a flatten can invalidate `#/allOf/0` the same way.
  //
  // Iterating settles it: each pass returns its INPUT REFERENCE when it changes
  // nothing, so a round that touches nothing ends the loop, and the bound keeps
  // a pathological schema from spinning. Two rounds cover every shape the
  // property sweep generates; the third is there so the bound is a backstop
  // rather than the mechanism.
  let doc = walked;
  for (let round = 0; round < 3; round++) {
    const before = doc;
    // #14 precedes rule (a): an inlinable `$ref` branch becomes an ordinary
    // object branch, so the union is kept rather than dropped. Anything still
    // unusable falls through to the drop.
    doc = ensureObjectRoot(
      flattenRootAllOf(dropUnusableRootUnions(inlineRootUnionRefs(prunedOrSame(doc)))),
    );
    if (doc === before) break;
  }
  return doc;
}
