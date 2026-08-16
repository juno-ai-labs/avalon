import { sanitizeToolSchema } from "@juno-ai/bind/tools";

const MAX_DEPTH = 64;

/** Positions holding a list of subschemas — where an emptied branch can hide. */
const COMPOSITION_KEYWORDS = ["allOf", "anyOf", "oneOf"] as const;

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
] as const;

/**
 * Positions holding a name → subschema map. A draft-07 `dependencies` value may
 * instead be a property-name list, which `collect` ignores as a non-object.
 */
const SUBSCHEMA_MAP_KEYWORDS = [
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependencies",
] as const;

/** Positions holding either one subschema or a list of them. */
const SUBSCHEMA_OR_LIST_KEYWORDS = ["items", "prefixItems"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every `allOf`/`anyOf`/`oneOf` branch that sanitization empties, as a path.
 *
 * A branch that arrives at `{}` is a constraint the author wrote and the wire
 * schema no longer carries. Bind's sanitizer prunes a `required` against the
 * *same node's* own `properties` (Gemini's validator resolves neither
 * composition nor parent scope), so the ordinary "exactly one of these" idiom —
 * a branch that is nothing but a `required`, with the properties declared on
 * the parent — prunes to nothing:
 *
 *   oneOf: [{ required: ["query"] }, { required: ["memoryItemId"] }]
 *     ↦  oneOf: [{}, {}]
 *
 * This is silent everywhere. Measured against nine live models, an emptied
 * branch is accepted by every one of them — the constraint is simply gone, and
 * the model is free to send both parameters or neither. That is worth failing a
 * build over on its own; it is *not*, on its own, what took the fleet down.
 * `nonObjectRootUnionBranches` covers the part that does.
 *
 * The check is deliberately *empty branch*, not *unsatisfiable*: satisfiability
 * needs a solver, and a branch the sanitizer emptied is a discarded constraint
 * whether or not the result still admits some instance.
 *
 * Express the constraint in the tool's `description` and enforce it in the
 * executor's zod parse instead — `z.toJSONSchema` cannot carry a `.refine()`
 * across the boundary either, so the wire schema was never where exclusivity
 * held. [`docs/agent-tools.md`](../../../docs/agent-tools.md) carries the rule.
 */
export function emptiedCompositionBranches(schema: Record<string, unknown>): string[] {
  const found: string[] = [];
  collect(sanitizeToolSchema(schema), "", 0, found);
  return found;
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
 * - A root union branch is fine when it is recognizably an object — it declares
 *   `type: "object"` **or** `properties`. Either alone is enough.
 * - A bare `{ required: [...] }` branch is not, and neither is `{}`. Both 400,
 *   whether the sanitizer emptied them or the author wrote them that way: the
 *   authored `oneOf: [{ required: ["query"] }, …]` fails identically to the
 *   sanitized `oneOf: [{}, {}]`. Restoring the `required` does not help.
 * - **Only the root matters.** The same bare-`required` and emptied unions
 *   nested under a property are accepted by all nine models.
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
  for (const keyword of COMPOSITION_KEYWORDS) {
    const branches = root[keyword];
    if (!Array.isArray(branches)) continue;
    branches.forEach((branch, index) => {
      const objectTyped = isPlainObject(branch)
        && (branch.type === "object" || isPlainObject(branch.properties));
      if (!objectTyped) found.push(`/${keyword}/${index}`);
    });
  }
  return found;
}

function collect(node: unknown, path: string, depth: number, found: string[]): void {
  if (!isPlainObject(node) || depth > MAX_DEPTH) return;
  const childDepth = depth + 1;
  for (const keyword of COMPOSITION_KEYWORDS) {
    const branches = node[keyword];
    if (!Array.isArray(branches)) continue;
    branches.forEach((branch, index) => {
      const branchPath = `${path}/${keyword}/${index}`;
      if (isPlainObject(branch) && Object.keys(branch).length === 0) found.push(branchPath);
      collect(branch, branchPath, childDepth, found);
    });
  }
  for (const keyword of SUBSCHEMA_KEYWORDS) {
    collect(node[keyword], `${path}/${keyword}`, childDepth, found);
  }
  for (const keyword of SUBSCHEMA_MAP_KEYWORDS) {
    const map = node[keyword];
    if (!isPlainObject(map)) continue;
    // Keys here are property names, never keywords: a parameter literally named
    // `oneOf` is a subschema to descend into, not a composition to inspect.
    for (const [name, value] of Object.entries(map)) {
      collect(value, `${path}/${keyword}/${name}`, childDepth, found);
    }
  }
  for (const keyword of SUBSCHEMA_OR_LIST_KEYWORDS) {
    const value = node[keyword];
    if (Array.isArray(value)) {
      value.forEach((entry, index) => collect(entry, `${path}/${keyword}/${index}`, childDepth, found));
      continue;
    }
    collect(value, `${path}/${keyword}`, childDepth, found);
  }
}
