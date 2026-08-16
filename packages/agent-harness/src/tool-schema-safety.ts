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
 * schema no longer carries — always a defect, and on xAI a fatal one. Bind's
 * sanitizer prunes a `required` against the *same node's* own `properties`
 * (Gemini's validator resolves neither composition nor parent scope), so the
 * ordinary "exactly one of these" idiom — a branch that is nothing but a
 * `required`, with the properties declared on the parent — prunes to nothing:
 *
 *   oneOf: [{ required: ["query"] }, { required: ["memoryItemId"] }]
 *     ↦  oneOf: [{}, {}]
 *
 * Which no instance can satisfy: everything matches both empty branches, so
 * "exactly one" is never true. Grok compiles tool schemas strictly and rejects
 * the request — the whole request, every tool — with a provider 400, and a run
 * pinned to it has no fallback to reach. That shipped in `memory_search`, a
 * core tool on every request, and took every x-ai call in the fleet down for
 * three days before anyone read a payload.
 *
 * The check is deliberately *empty branch*, not *unsatisfiable*: satisfiability
 * needs a solver and a vacuous `anyOf` branch is a silently discarded
 * constraint whether or not the result still admits some instance.
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
