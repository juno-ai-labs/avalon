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
 * - **A branch carrying its own composition is rejected even with
 *   `type: "object"`.** `{ type: "object", anyOf: [...] }` 400s on all three
 *   Grok models, so nesting a union one level down inside a root branch does
 *   not escape the rule; it is the same 400 as putting it at the root.
 */
function readableRootUnionBranch(branch: unknown): boolean {
  if (!isPlainObject(branch)) return false;
  if ("type" in branch ? branch.type !== "object" : !isPlainObject(branch.properties)) return false;
  return !COMPOSITION_KEYWORDS.some((keyword) => Array.isArray(branch[keyword]));
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
 * visible form. `{ description: "choose a", required: ["a"] }` sanitizes to
 * `{ description: "choose a" }` and `{ type: "object", required: ["query"] }`
 * to `{ type: "object" }` — neither is empty, and the constraint is just as
 * gone. Both are reported here.
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
 * Make a schema Avalon did not write safe to put in front of a provider.
 *
 * The guard above is a build-time check over schemas this repository authors. A
 * hosted MCP server's `inputSchema` is not one of those: it arrives at run time,
 * from a third party, and goes to the model verbatim. Nothing in a test can see
 * it, and the blast radius is the same or worse — xAI rejects the **whole
 * request, every tool**, so one bad schema from one remote server takes down a
 * run that had nothing to do with it, including Avalon's own core tools.
 *
 * So the same measured rule is applied as a repair rather than a report — the
 * literally same predicate, `readableRootUnionBranch` — and when a root
 * `anyOf`/`oneOf` has a branch that fails it, the whole composition is dropped
 * and the rest of the schema is kept. Measured 27/27
 * accepted across nine models, and it is the same trade the four first-party
 * tools took — the constraint was already being erased for every provider by
 * the sanitizer's `required` pruning, and a remote MCP server validates its own
 * arguments regardless, so what is given up here is a wire-level hint that was
 * not being honoured, in exchange for the request surviving at all.
 *
 * Repair rather than reject, because rejecting is worse in both directions: it
 * removes a capability the person connected on purpose, and it does so on a
 * judgement about a *provider's* schema dialect rather than anything the person
 * did. Nothing else is touched — Bind's sanitizer still runs afterwards and
 * still owns every other dialect difference.
 */
export function repairRootUnionForProviders(schema: Record<string, unknown>): Record<string, unknown> {
  let repaired = schema;
  for (const keyword of ROOT_UNION_KEYWORDS) {
    const branches = repaired[keyword];
    if (!Array.isArray(branches)) continue;
    if (branches.every(readableRootUnionBranch)) continue;
    repaired = Object.fromEntries(Object.entries(repaired).filter(([key]) => key !== keyword));
  }
  return repaired;
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
 * The two trees are structurally identical — the sanitizer rebuilds the spine
 * but never reorders or drops a branch — so the same path indexes both.
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
    const sanitizedBranches = sanitized[keyword];
    if (!Array.isArray(authoredBranches) || !Array.isArray(sanitizedBranches)) continue;
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
