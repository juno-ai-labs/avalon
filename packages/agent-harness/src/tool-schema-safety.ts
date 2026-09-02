import { sanitizeToolSchema } from "@juno-ai/bind/tools";

const MAX_DEPTH = 64;

/** Positions holding a list of subschemas — where a weakened branch can hide. */
const COMPOSITION_KEYWORDS = ["allOf", "anyOf", "oneOf"] as const;

/**
 * The composition keywords xAI treats as a *union* at the parameters root.
 *
 * `allOf` is deliberately absent: it is an intersection, and a root `allOf` —
 * of constraint-only branches, and of branches Bind's flatten cannot merge — is
 * accepted by all nine models measured, Grok included. Flagging it would fail
 * schemas no provider objects to.
 */
const ROOT_UNION_KEYWORDS = ["anyOf", "oneOf"] as const;

/**
 * Whether xAI will read one branch of a **root** union as an object.
 *
 * Shared by the report and the repair below so the two cannot drift: a rule
 * that only half the codebase enforces is worse than one nobody does, because
 * the guard goes green on exactly the schema the repair lets through.
 *
 * Every clause was measured against grok-4.3/4.5/4.6, and confirmed harmless on
 * gemini-3.5/3.6/3.7-flash and gpt-5.6-terra/sol/luna:
 *
 * - `type: "object"` alone qualifies, and `properties` alone qualifies when the
 *   branch declares no `type` at all.
 * - **A declared `type` decides by itself.** `{ type: "string", properties: {…} }`
 *   is rejected exactly like a bare `{ type: "string" }` — the `properties` does
 *   not rescue a branch whose own `type` contradicts it.
 * - **A branch carrying its own *union* is rejected even with `type: "object"`.**
 *   `{ type: "object", anyOf: [...] }` 400s on all three Grok models, so nesting
 *   a union one level down inside a root branch does not escape the rule; it is
 *   the same 400 as putting it at the root. Two boundaries here, both measured
 *   and both easy to get wrong in opposite directions:
 *   - It is `anyOf`/`oneOf` only. A branch carrying its own **`allOf`** is
 *     accepted by all nine models, Grok included — an intersection is not a
 *     union — and Bind 13 deliberately keeps it. Rejecting it here would make
 *     the repair below delete a root union the sanitizer had preserved,
 *     destroying a constraint to fix a problem that does not exist.
 *   - The objection reaches the branch's **own** keywords only — a composition
 *     under one of its `properties` is accepted by all nine models — so this
 *     must never become a subtree scan, for the same reason.
 *
 * **The rule is stated over a *sanitized* branch**, which is the only form that
 * reaches a provider, and both callers pass one. It is deliberately literal
 * about `type` as a result: an array `type` such as `["object", "null"]` reads
 * as unreadable here, which is wrong for an authored schema and irrelevant for a
 * sanitized one, because Bind collapses a type array to a scalar before this
 * ever sees it. Anyone applying this predicate to an authored schema — a legal
 * shape for a third-party MCP server to serve — should sanitize first.
 *
 * Bind 13 handles every clause here, so nothing in the shipped tool surface
 * currently trips it. It is kept as the statement of the rule itself: the
 * clauses cost roughly two hundred live provider requests to establish, and
 * they are what a future sanitizer regression would be measured against.
 */
export function readableRootUnionBranch(branch: unknown): boolean {
  if (!isPlainObject(branch)) return false;
  if ("type" in branch ? branch.type !== "object" : !isPlainObject(branch.properties)) return false;
  return !ROOT_UNION_KEYWORDS.some((keyword) => Array.isArray(branch[keyword]));
}

/**
 * Keywords that assert nothing about an instance. A branch left holding only
 * these has had its constraint erased even though it is not literally empty.
 */
const ANNOTATION_KEYWORDS: ReadonlySet<string> = new Set([
  "title",
  "description",
  "$comment",
  "examples",
  "default",
  "deprecated",
  "readOnly",
  "writeOnly",
]);

/** Positions holding exactly one subschema. */
const SUBSCHEMA_KEYWORDS = [
  "not",
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
  "additionalProperties",
  "additionalItems",
  "unevaluatedItems",
  "unevaluatedProperties",
  "contentSchema",
] as const;

/**
 * Positions holding a name → subschema map. `dependentSchemas` is the 2019-09
 * successor to the schema form of draft-07's `dependencies`, and Bind's
 * sanitizer walks it, so a branch underneath it can be weakened exactly like
 * any other. A draft-07 `dependencies` value may instead be a property-name
 * list, which the walk ignores as a non-object.
 */
const SUBSCHEMA_MAP_KEYWORDS = [
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependencies",
  "dependentSchemas",
] as const;

/** Positions holding either one subschema or a list of them. */
const SUBSCHEMA_OR_LIST_KEYWORDS = ["items", "prefixItems"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A key two schemas share when they say the same thing, so that a property
 * redeclared identically across branches stays one declaration.
 *
 * Key order carries no meaning in JSON Schema and two branches are written by
 * hand, so object keys are sorted before comparing; plain `JSON.stringify`
 * would read `{type,const}` and `{const,type}` as different and emit a union of
 * a schema with itself.
 */
function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  if (!isPlainObject(value)) return JSON.stringify(value) ?? "null";
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableKey(value[key])}`).join(",")}}`;
}

/**
 * Every `allOf`/`anyOf`/`oneOf` branch that sanitization strips a constraint
 * from, as a path with the reason.
 *
 * Bind's sanitizer prunes a `required` against the *same node's* own
 * `properties` (Gemini's validator resolves neither composition nor parent
 * scope), so the ordinary "exactly one of these" idiom — a branch that is
 * nothing but a `required`, with the properties declared on the parent — prunes
 * to nothing:
 *
 *   oneOf: [{ required: ["query"] }, { required: ["memoryItemId"] }]
 *     ↦  oneOf: [{}, {}]
 *
 * This compares the authored schema against the sanitized one rather than
 * looking for an empty result, because an emptied branch is only the most
 * visible form. `{ description: "choose a", required: ["a"] }` used to sanitize
 * to `{ description: "choose a" }` and `{ type: "object", required: ["query"] }`
 * to `{ type: "object" }` — neither empty, and the constraint just as gone.
 *
 * **Bind 12 and 13 repair all of those**: a branch's `required` now resolves
 * against its parent's `properties`, and the referenced subschemas are copied
 * down, so the constraint reaches the wire. Two forms still report, and the
 * second is now the more consequential:
 *
 * - `(required dropped)` — a branch naming something *nothing* in scope
 *   declares, which remains unrepairable and is still pruned away.
 * - `(composition dropped)` — a whole root union Bind removed, which it does
 *   when no branch of it can be made usable. See `walkPair` for why a vanished
 *   keyword has to be reported rather than skipped.
 *
 * Keep the check rather than trusting the dependency: it costs nothing when
 * there is nothing to find, and it is what would notice a bind release that
 * stopped repairing.
 *
 * The loss is silent on every provider measured: nine live models accept a
 * weakened branch without complaint and let the model send both parameters or
 * neither. That is worth failing a build over on its own; it is *not*, on its
 * own, what took the fleet down. `nonObjectRootUnionBranches` covers that.
 *
 * The check is deliberately *constraint removed*, not *unsatisfiable*:
 * satisfiability needs a solver, and a branch the sanitizer weakened is a
 * discarded constraint whether or not the result still admits some instance.
 *
 * Express the constraint in the tool's `description` and enforce it in the
 * executor's zod parse instead — `z.toJSONSchema` cannot carry a `.refine()`
 * across the boundary either, so the wire schema was never where exclusivity
 * held. [`docs/agent-tools.md`](../../../docs/agent-tools.md) carries the rule.
 */
export function weakenedCompositionBranches(schema: Record<string, unknown>): string[] {
  const found: string[] = [];
  walkPair(schema, sanitizeToolSchema(schema), "", 0, found);
  return found;
}

/**
 * Make any tool schema safe to put in front of every provider Rally routes to.
 *
 * This is the corrector, and it is the load-bearing half of this module. The
 * checks above are build-time reports over schemas this repository authors; a
 * hosted MCP server's `inputSchema` is not one of those, and neither is a tool
 * somebody adds next year. Both reach a provider verbatim, and a fatal root
 * schema fails the **whole request, every tool** — one bad schema from one
 * remote server takes down a run that had nothing to do with it, including
 * Rally's own core tools.
 *
 * So it runs on every tool on the way to the wire rather than on remote ones
 * alone. Two rules have been measured, and this satisfies the stricter:
 *
 * - xAI rejects a root union with a branch it cannot read as an object.
 * - Azure OpenAI rejects a root-level combinator of any kind, readable branches
 *   or not. See {@link ROOT_FORBIDDEN_KEYWORDS} for the measured error strings.
 *
 * **Merge rather than drop.** The earlier version deleted the offending root
 * keywords, which is destructive in a way that was easy to miss: a schema whose
 * root is *only* an `anyOf` — which is exactly what `z.union` emits, and what
 * `workstream_list_resources` was — deletes down to `{}`, a tool advertising no
 * parameters at all. The model then cannot pass the arguments the executor
 * still requires. Flattening keeps every property the branches declared, and
 * was verified against the live `gpt-5.6-sol` deployment: the same 28-tool
 * surface that answered `invalid_function_parameters` is accepted once its two
 * root unions are merged this way.
 *
 * What a merge cannot keep is the *exclusivity* — that branch A and branch B
 * are alternatives. That is a real loss on xAI, which could read it, and it is
 * accepted knowingly: a constraint no provider is guaranteed to receive is
 * worth less than a request that reaches all of them, and `z.toJSONSchema`
 * could never carry a `.refine()` across the boundary anyway. Exclusivity
 * belongs in the tool's `description` and the executor's parse, which is where
 * [`docs/agent-tools.md`](../../../docs/agent-tools.md) already puts it.
 *
 * Repair rather than reject, because rejecting removes a capability the person
 * connected on purpose, over a judgement about a provider's schema dialect
 * rather than anything they did. Bind's sanitizer still runs afterwards and
 * still owns every other dialect difference.
 */
export function repairRootSchemaForProviders(schema: Record<string, unknown>): Record<string, unknown> {
  // Gated on the report so the corrector is a no-op for the shapes already
  // safe, and so it re-engages by itself for any shape a future sanitizer stops
  // handling, without anyone having to notice.
  if (nonObjectRootSchema(schema).length === 0) return schema;

  // Every distinct declaration of each property name, in the order met. A
  // discriminated union — the commonest root union a hosted MCP server serves —
  // redeclares its discriminator per branch with a different `const`, so
  // first-declaration-wins would advertise one branch's value as the only legal
  // one and silently delete the rest. That is a schema the model cannot argue
  // with and no log would ever show, which is the failure this repository asks
  // to be traded away rather than kept.
  const variants = new Map<string, unknown[]>();
  const declare = (name: string, subschema: unknown): void => {
    const seen = variants.get(name);
    if (!seen) {
      variants.set(name, [subschema]);
      return;
    }
    // A branch that repeats a declaration verbatim is the same constraint, not
    // an alternative; only genuinely different shapes become a union.
    if (!seen.some((entry) => stableKey(entry) === stableKey(subschema))) seen.push(subschema);
  };
  if (isPlainObject(schema.properties)) {
    for (const [name, subschema] of Object.entries(schema.properties)) declare(name, subschema);
  }
  // `required` is intersected across the branches of a union and unioned across
  // an intersection, which is the most the flattened root can still assert. A
  // union's branches are alternatives, so only a name *every* branch demands is
  // demanded by the whole; taking their union instead would invent a
  // requirement no branch stated and make the tool uncallable.
  const rootRequired = requiredNames(schema);
  let unionRequired: string[] | null = null;
  const intersectionRequired = new Set<string>(rootRequired);

  for (const keyword of ROOT_FORBIDDEN_KEYWORDS) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      if (!isPlainObject(branch)) continue;
      if (isPlainObject(branch.properties)) {
        for (const [name, subschema] of Object.entries(branch.properties)) declare(name, subschema);
      }
      const names = requiredNames(branch);
      if (keyword === "allOf") {
        for (const name of names) intersectionRequired.add(name);
        continue;
      }
      unionRequired = unionRequired === null
        ? [...names]
        : unionRequired.filter((name) => names.includes(name));
    }
  }
  for (const name of unionRequired ?? []) intersectionRequired.add(name);

  // A name declared differently by different branches becomes a union *under*
  // the property, which is the one place a provider accepts one: the same
  // deployment that rejects a root `anyOf` accepts `table_query`'s nested
  // recursive `$ref` union and `core_request_elicitation`'s nested nullable
  // union. The model is then told every shape some branch allowed, which is a
  // wider statement than the union made and an honest one, rather than a
  // narrower statement that is false.
  const properties = Object.fromEntries(
    [...variants].map(([name, entries]) => [name, entries.length === 1 ? entries[0] : { anyOf: entries }]),
  );

  // Only names the flattened root actually declares. A branch may require a
  // property whose subschema lived on a sibling the merge could not read, and a
  // `required` naming a property that is not there is the very shape Bind's
  // sanitizer prunes away.
  const required = [...intersectionRequired].filter((name) => name in properties);

  return {
    ...Object.fromEntries(
      Object.entries(schema).filter(([key]) => (
        key !== "required" && key !== "properties" && key !== "type"
        && !ROOT_FORBIDDEN_KEYWORDS.some((keyword) => keyword === key)
      )),
    ),
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

/**
 * The keywords Azure OpenAI refuses at a tool parameter **root**, whatever else
 * the root carries.
 *
 * Measured against the live `gpt-5.6-sol` Foundry deployment on 2026-09-02, and
 * it is a stricter rule than the xAI one below rather than a variation on it.
 * Two error strings, in this order:
 *
 * - A root with no `type` at all: `Invalid schema for function
 *   'workstream_list_resources': schema must be a JSON Schema of 'type:
 *   "object"', got 'type: "None"'.`
 * - The same root with `type: "object"` added beside the union, which is the
 *   obvious patch and **does not work**: `schema must have type 'object' and
 *   not have 'oneOf'/'anyOf'/'allOf'/'enum'/'const'/'not' at the top level.`
 *
 * So there is no root-level combinator this provider accepts, readable branches
 * or not, and `allOf` is in scope here even though it is deliberately out of
 * scope for {@link ROOT_UNION_KEYWORDS}. A rejected schema fails the **whole
 * request, every tool**, exactly as on xAI.
 *
 * Only the root is checked, and that is measured too: `table_query` carries a
 * self-recursive `$defs`/`$ref` and `core_request_elicitation` a nested
 * `anyOf` with a `null` branch, and the same deployment accepts both when they
 * are the only tool sent.
 */
const ROOT_FORBIDDEN_KEYWORDS = ["anyOf", "oneOf", "allOf", "enum", "const", "not"] as const;

/**
 * Why a tool's root schema is not the plain object every provider will read.
 *
 * This is the rule the fleet actually has to satisfy, and it is the one worth
 * reaching for when authoring a tool: **a parameters root is
 * `{ type: "object", properties: {…} }` and nothing else.** Both known provider
 * rules are then satisfied by construction, and no third one can be violated by
 * a shape this forbids.
 *
 * It supersedes {@link nonObjectRootUnionBranches} rather than replacing it.
 * That check states xAI's rule, which is narrower — a root union whose branches
 * all read as objects passes it and is still fatal here — and it is kept
 * because it is what a future sanitizer regression would be measured against,
 * and because {@link repairRootUnionForProviders} needs to know which of the
 * two rules a third-party schema broke.
 *
 * Stated over the schema **as authored**, which is the one difference from
 * every other rule in this module and the one that matters. Those are stated
 * over `sanitizeToolSchema`'s output; this repository's own transports do not
 * run it before serializing a tool, and the archived Azure request that failed
 * on 2026-09-02 carried `workstream_list_resources` with the bare root `anyOf`
 * exactly as `z.toJSONSchema` emitted it. Judging a sanitized copy would let
 * through any schema the sanitizer repairs and the wire does not — a root with
 * no `type` that gains one only in a form nobody sends is still a 400.
 */
export function nonObjectRootSchema(schema: Record<string, unknown>): string[] {
  const root = schema;
  const found = ROOT_FORBIDDEN_KEYWORDS
    .filter((keyword) => keyword in root)
    .map((keyword) => `/${keyword} (not allowed at the root)`);
  if (root.type !== "object") {
    found.push(`/type (root must be "object", got ${JSON.stringify(root.type ?? null)})`);
  }
  return found;
}

function requiredNames(node: Record<string, unknown>): string[] {
  return Array.isArray(node.required) ? node.required.filter((name): name is string => typeof name === "string") : [];
}

/** A branch left holding only annotations constrains nothing, empty or not. */
function assertsNothing(node: Record<string, unknown>): boolean {
  return Object.keys(node).every((key) => ANNOTATION_KEYWORDS.has(key));
}

/**
 * Every branch of a **root-level** union that xAI will not read as an object.
 *
 * This is the one that fails the request. Grok answers a hard 400 —
 * `invalid-argument: <tool>: tool parameter root must be an object type (root
 * schema is an anyOf/oneOf union with a non-object branch)` — and OpenRouter
 * surfaces it as a provider error covering the **whole request, every tool**,
 * not just the offending one. A run pinned to Grok has no fallback to reach and
 * dies with a bare `harness_execution_failed`.
 *
 * The rule was measured, not inferred, against grok-4.3/4.5/4.6 plus three
 * Gemini and three GPT models:
 *
 * - A root union branch is fine when xAI reads it as an object;
 *   `readableRootUnionBranch` above holds the exact rule and why each clause of
 *   it is there.
 * - A bare `{ required: [...] }` branch is not, and neither is `{}`, and neither
 *   is an annotation-only `{ description: "…" }`. All three 400, whether the
 *   sanitizer left them that way or the author wrote them that way: the
 *   authored `oneOf: [{ required: ["query"] }, …]` fails identically to the
 *   sanitized `oneOf: [{}, {}]`. Restoring the `required` does not help.
 * - **Only the root matters.** The same bare-`required` and emptied unions
 *   nested under a property are accepted by all nine models.
 * - **Only a union.** `allOf` is an intersection and is not checked: a root
 *   `allOf`, both of constraint-only branches and of branches Bind's flatten
 *   cannot merge, is accepted by all nine models including every Grok. Treating
 *   it as a union here would fail schemas no provider objects to.
 *
 * So the branch shape to reach for, when a choice must be structural at all, is
 * a full object schema per branch — `{ type: "object", properties: {…},
 * required: [...] }`, which also survives sanitization intact because each
 * branch then carries the `properties` the `required`-pruning resolves against.
 * `workstream_list_resources` and `workstream_read_resource` are built that way
 * and never broke.
 */
export function nonObjectRootUnionBranches(schema: Record<string, unknown>): string[] {
  const root = sanitizeToolSchema(schema);
  const found: string[] = [];
  for (const keyword of ROOT_UNION_KEYWORDS) {
    const branches = root[keyword];
    if (!Array.isArray(branches)) continue;
    branches.forEach((branch, index) => {
      if (!readableRootUnionBranch(branch)) found.push(`/${keyword}/${index}`);
    });
  }
  return found;
}

/**
 * Walk the authored schema and its sanitized copy in step, reporting each
 * composition branch the sanitizer took a constraint out of.
 *
 * The trees are *nearly* parallel, so the same path indexes both — but not
 * identical, and the difference matters. Bind 13 removes a root composition
 * outright when no branch of it can be made usable. That is provider-safe and
 * deliberate, and it is still an authored constraint that did not reach the
 * wire, so a vanished keyword is reported rather than skipped. Treating the two
 * trees as structurally identical, which an earlier version of this walk did,
 * meant a whole erased union slipped past both checks: `walkPair` stopped at the
 * missing array, and `nonObjectRootUnionBranches` had nothing left to find
 * because the union it would have judged was gone.
 */
function walkPair(
  authored: unknown,
  sanitized: unknown,
  path: string,
  depth: number,
  found: string[],
): void {
  if (!isPlainObject(authored) || !isPlainObject(sanitized) || depth > MAX_DEPTH) return;
  const childDepth = depth + 1;
  for (const keyword of COMPOSITION_KEYWORDS) {
    const authoredBranches = authored[keyword];
    if (!Array.isArray(authoredBranches)) continue;
    const sanitizedBranches = sanitized[keyword];
    if (!Array.isArray(sanitizedBranches)) {
      found.push(`${path}/${keyword} (composition dropped)`);
      continue;
    }
    authoredBranches.forEach((authoredBranch, index) => {
      const sanitizedBranch = sanitizedBranches[index];
      const branchPath = `${path}/${keyword}/${index}`;
      if (isPlainObject(authoredBranch) && isPlainObject(sanitizedBranch)) {
        const lost = requiredNames(authoredBranch).length - requiredNames(sanitizedBranch).length;
        if (lost > 0) found.push(`${branchPath} (required dropped)`);
        else if (assertsNothing(sanitizedBranch)) found.push(`${branchPath} (constrains nothing)`);
      }
      walkPair(authoredBranch, sanitizedBranch, branchPath, childDepth, found);
    });
  }
  for (const keyword of SUBSCHEMA_KEYWORDS) {
    walkPair(authored[keyword], sanitized[keyword], `${path}/${keyword}`, childDepth, found);
  }
  for (const keyword of SUBSCHEMA_MAP_KEYWORDS) {
    const authoredMap = authored[keyword];
    const sanitizedMap = sanitized[keyword];
    if (!isPlainObject(authoredMap) || !isPlainObject(sanitizedMap)) continue;
    // Keys here are property names, never keywords: a parameter literally named
    // `oneOf` is a subschema to descend into, not a composition to inspect.
    for (const name of Object.keys(authoredMap)) {
      walkPair(authoredMap[name], sanitizedMap[name], `${path}/${keyword}/${name}`, childDepth, found);
    }
  }
  for (const keyword of SUBSCHEMA_OR_LIST_KEYWORDS) {
    const authoredValue = authored[keyword];
    const sanitizedValue = sanitized[keyword];
    if (Array.isArray(authoredValue) && Array.isArray(sanitizedValue)) {
      authoredValue.forEach((entry, index) => {
        walkPair(entry, sanitizedValue[index], `${path}/${keyword}/${index}`, childDepth, found);
      });
      continue;
    }
    walkPair(authoredValue, sanitizedValue, `${path}/${keyword}`, childDepth, found);
  }
}
