import type { ZodValidationError } from "@rally/contracts/zod-error";
import { isZodValidationError } from "@rally/contracts/zod-error";
import { z } from "zod";

const MAX_SCHEMA_DEPTH = 64;
const MAX_SCHEMA_VISITS = 10_000;
const MAX_VALIDATION_ISSUES = 5;
const MAX_VALIDATION_ERROR_CHARACTERS = 1_200;
const JSON_NUMBER_TEXT = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;
const UNSAFE_REFERENCE_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

type JsonObject = Record<string, unknown>;
type NumericKind = "integer" | "number";
type Normalized = { value: unknown; changed: boolean };
type SchemaVisitBudget = { remaining: number };

export type ToolInputValidationError = ZodValidationError;
export { isZodValidationError };

/**
 * Apply the one model-tolerance rule shared by every harness tool: a string may
 * stand in for a schema-declared number only when the complete string is a
 * finite JSON number and JavaScript can represent any integral value safely.
 *
 * The provider-facing schema remains numeric so models still learn the
 * preferred shape. String alternatives remain strings: identifiers and free
 * text must not change meaning merely because their characters look numeric.
 */
export function normalizeToolArguments(input: unknown, schema: Record<string, unknown>): unknown {
  return normalizeValue(input, schema, schema, 0, { remaining: MAX_SCHEMA_VISITS }).value;
}

/**
 * Validate the normalized model input against the same JSON Schema advertised
 * to the provider. Tool executors may perform stricter domain checks, but a
 * failure here is unambiguously an argument-shape error rather than a Zod error
 * raised later while validating provider or stored data.
 */
export function validateToolArguments(
  input: unknown,
  schema: Record<string, unknown>,
): z.ZodError | null {
  try {
    const result = z.fromJSONSchema(schema).safeParse(input);
    return result.success ? null : result.error;
  } catch {
    // Hosted tools own their schemas. If one uses a JSON Schema feature this
    // local classifier cannot compile, do not blame the model for a later Zod
    // failure; preserve it as an external data-validation error.
    return null;
  }
}

/** Turn a Zod issue tree into one bounded correction a routed model can act on. */
export function formatToolArgumentValidationError(error: ToolInputValidationError): string {
  const issues = selectActionableIssues(error.issues).slice(0, MAX_VALIDATION_ISSUES);
  const details = issues.map(formatIssue).filter(Boolean);
  const message = details.length > 0
    ? `Tool arguments were invalid. Fix these fields and retry: ${details.join("; ")}`
    : "Tool arguments were invalid. Match the declared schema and retry.";
  return truncate(message, MAX_VALIDATION_ERROR_CHARACTERS);
}

function normalizeValue(
  input: unknown,
  schemaValue: unknown,
  rootSchema: JsonObject,
  depth: number,
  budget: SchemaVisitBudget,
): Normalized {
  if (depth > MAX_SCHEMA_DEPTH || !isObject(schemaValue) || !consumeSchemaVisit(budget)) {
    return { value: input, changed: false };
  }
  const schema = schemaValue;
  let current: Normalized = { value: input, changed: false };

  const reference = typeof schema.$ref === "string" ? resolveLocalReference(rootSchema, schema.$ref) : null;
  if (reference) {
    current = mergeNormalized(current, normalizeValue(current.value, reference, rootSchema, depth + 1, budget));
  }

  current = mergeNormalized(current, normalizeDirect(current.value, schema, rootSchema, depth + 1, budget));

  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) {
      current = mergeNormalized(current, normalizeValue(current.value, branch, rootSchema, depth + 1, budget));
    }
  }

  const alternatives = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : null;
  if (alternatives?.length) {
    const candidates = alternatives.map((branch, index) => {
      const normalized = normalizeValue(current.value, branch, rootSchema, depth + 1, budget);
      return {
        ...normalized,
        index,
        score: schemaMismatchScore(normalized.value, branch, rootSchema, depth + 1, budget),
      };
    });
    candidates.sort((left, right) =>
      left.score - right.score
      || Number(left.changed) - Number(right.changed)
      || left.index - right.index
    );
    const selected = candidates[0];
    if (selected) current = mergeNormalized(current, selected);
  }

  return current;
}

function normalizeDirect(
  input: unknown,
  schema: JsonObject,
  rootSchema: JsonObject,
  depth: number,
  budget: SchemaVisitBudget,
): Normalized {
  const numericKind = exclusiveNumericKind(schema);
  if (numericKind && typeof input === "string") {
    const parsed = parseExactNumericString(input, numericKind);
    if (parsed !== null) return { value: parsed, changed: true };
  }

  if (Array.isArray(input)) {
    let changed = false;
    const prefixItems = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
    const values = input.map((item, index) => {
      const itemSchema = prefixItems[index] ?? schema.items;
      const normalized = normalizeValue(item, itemSchema, rootSchema, depth + 1, budget);
      changed ||= normalized.changed;
      return normalized.value;
    });
    return changed ? { value: values, changed: true } : { value: input, changed: false };
  }

  if (!isObject(input)) return { value: input, changed: false };
  const properties = isObject(schema.properties) ? schema.properties : {};
  const entries: Array<[string, unknown]> = [];
  let changed = false;

  for (const [key, value] of Object.entries(input)) {
    let normalized: Normalized = { value, changed: false };
    if (Object.prototype.hasOwnProperty.call(properties, key)) {
      normalized = normalizeValue(value, properties[key], rootSchema, depth + 1, budget);
    } else if (isObject(schema.additionalProperties)) {
      normalized = normalizeValue(value, schema.additionalProperties, rootSchema, depth + 1, budget);
    }
    changed ||= normalized.changed;
    entries.push([key, normalized.value]);
  }

  return changed ? { value: Object.fromEntries(entries), changed: true } : { value: input, changed: false };
}

function exclusiveNumericKind(schema: JsonObject): NumericKind | null {
  const types = typeof schema.type === "string"
    ? [schema.type]
    : Array.isArray(schema.type)
      ? schema.type.filter((value): value is string => typeof value === "string")
      : [];
  if (types.includes("string")) return null;
  if (types.includes("number")) return "number";
  if (types.includes("integer")) return "integer";
  return null;
}

function parseExactNumericString(value: string, kind: NumericKind): number | null {
  if (!JSON_NUMBER_TEXT.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const coefficient = value.split(/[eE]/u, 1)[0] ?? value;
  if (parsed === 0 && /[1-9]/u.test(coefficient)) return null;
  if (Number.isInteger(parsed) && !Number.isSafeInteger(parsed)) return null;
  if (kind === "integer" && !Number.isSafeInteger(parsed)) return null;
  return parsed;
}

function schemaMismatchScore(
  input: unknown,
  schemaValue: unknown,
  rootSchema: JsonObject,
  depth: number,
  budget: SchemaVisitBudget,
): number {
  if (depth > MAX_SCHEMA_DEPTH || !isObject(schemaValue) || !consumeSchemaVisit(budget)) return 0;
  const schema = schemaValue;
  let score = 0;
  const reference = typeof schema.$ref === "string" ? resolveLocalReference(rootSchema, schema.$ref) : null;
  if (reference) score += schemaMismatchScore(input, reference, rootSchema, depth + 1, budget);

  const types = typeof schema.type === "string"
    ? [schema.type]
    : Array.isArray(schema.type)
      ? schema.type.filter((value): value is string => typeof value === "string")
      : [];
  if (types.length > 0 && !types.some((type) => valueMatchesType(input, type))) score += 100;
  if (Object.prototype.hasOwnProperty.call(schema, "const") && !sameJsonValue(input, schema.const)) score += 30;
  if (Array.isArray(schema.enum) && !schema.enum.some((value) => sameJsonValue(input, value))) score += 30;

  if (isObject(input)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === "string")
      : [];
    score += required.filter((key) => !Object.prototype.hasOwnProperty.call(input, key)).length * 10;
    for (const [key, nestedSchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(input, key)) {
        score += schemaMismatchScore(input[key], nestedSchema, rootSchema, depth + 1, budget);
      }
    }
    if (schema.additionalProperties === false) {
      score += Object.keys(input).filter((key) => !Object.prototype.hasOwnProperty.call(properties, key)).length * 5;
    }
  } else if (Array.isArray(input)) {
    const prefixItems = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
    for (const [index, item] of input.entries()) {
      score += schemaMismatchScore(item, prefixItems[index] ?? schema.items, rootSchema, depth + 1, budget);
    }
  }

  if (Array.isArray(schema.allOf)) {
    score += schema.allOf.reduce(
      (total, branch) => total + schemaMismatchScore(input, branch, rootSchema, depth + 1, budget),
      0,
    );
  }
  const alternatives = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : null;
  if (alternatives?.length) {
    score += Math.min(...alternatives.map((branch) =>
      schemaMismatchScore(input, branch, rootSchema, depth + 1, budget)));
  }
  return score;
}

function consumeSchemaVisit(budget: SchemaVisitBudget): boolean {
  if (budget.remaining <= 0) return false;
  budget.remaining -= 1;
  return true;
}

function valueMatchesType(value: unknown, type: string): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isObject(value);
  if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function resolveLocalReference(rootSchema: JsonObject, reference: string): unknown | null {
  if (reference === "#") return rootSchema;
  if (!reference.startsWith("#/")) return null;
  let current: unknown = rootSchema;
  for (const encoded of reference.slice(2).split("/")) {
    const segment = encoded.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (UNSAFE_REFERENCE_SEGMENTS.has(segment) || (!isObject(current) && !Array.isArray(current))) return null;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function mergeNormalized(previous: Normalized, next: Normalized): Normalized {
  return { value: next.value, changed: previous.changed || next.changed };
}

function sameJsonValue(left: unknown, right: unknown, depth = 0): boolean {
  if (depth > MAX_SCHEMA_DEPTH) return false;
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length
      && left.every((value, index) => sameJsonValue(value, right[index], depth + 1));
  }
  if (isObject(left) && isObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key) =>
        Object.prototype.hasOwnProperty.call(right, key)
        && sameJsonValue(left[key], right[key], depth + 1)
      );
  }
  return false;
}

function selectActionableIssues(issues: readonly unknown[]): JsonObject[] {
  return issues.flatMap((issue) => {
    if (!isObject(issue)) return [];
    if (issue.code !== "invalid_union" || !Array.isArray(issue.errors)) return [issue];
    const branches = issue.errors
      .filter(Array.isArray)
      .map((branch) => selectActionableIssues(branch));
    branches.sort((left, right) => issueWeight(left) - issueWeight(right));
    return branches[0] ?? [issue];
  });
}

function issueWeight(issues: JsonObject[]): number {
  return issues.reduce((total, issue) => {
    const keyCount = Array.isArray(issue.keys) ? issue.keys.length : 0;
    return total + 1 + (issue.code === "unrecognized_keys" ? keyCount : 0);
  }, 0);
}

function formatIssue(issue: JsonObject): string {
  const path = Array.isArray(issue.path)
    ? issue.path.filter((part): part is string | number => typeof part === "string" || typeof part === "number")
    : [];
  const location = path.length > 0 ? formatPath(path) : "arguments";
  if (issue.code === "unrecognized_keys" && Array.isArray(issue.keys)) {
    const keys = issue.keys.filter((value): value is string => typeof value === "string").slice(0, 5);
    return keys.length > 0
      ? `${location}: remove unrecognized ${keys.length === 1 ? "field" : "fields"} ${keys.join(", ")}`
      : `${location}: remove unrecognized fields`;
  }
  const rawMessage = typeof issue.message === "string" ? issue.message : "does not match the declared schema";
  const message = rawMessage.replace(/^Invalid input:\s*/u, "");
  return `${location}: ${lowercaseFirst(message)}`;
}

function formatPath(path: Array<string | number>): string {
  return path.map((part, index) =>
    typeof part === "number"
      ? `[${part}]`
      : index === 0
        ? part
        : `.${part}`
  ).join("");
}

function lowercaseFirst(value: string): string {
  return value ? value[0]!.toLowerCase() + value.slice(1) : value;
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
