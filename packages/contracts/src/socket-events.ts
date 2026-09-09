import type { z } from "zod";

/** Receivers tolerate additions without weakening the contracts used by senders. */
export function safeParseSocketEvent<T>(schema: z.ZodType<T>, value: unknown): z.ZodSafeParseResult<T> {
  const result = schema.safeParse(value);
  if (result.success) return result;
  const additions = unknownKeys(result.error.issues);
  if (!additions?.length) return result;
  const compatible: unknown = structuredClone(value);
  for (const { path, keys } of additions) {
    let target: unknown = compatible;
    for (const part of path) {
      if (typeof target !== "object" || target === null || !Object.hasOwn(target, part)) return result;
      target = Reflect.get(target, part);
    }
    if (typeof target !== "object" || target === null) return result;
    for (const key of keys) Reflect.deleteProperty(target, key);
  }
  return schema.safeParse(compatible);
}

type UnknownKeys = Extract<z.core.$ZodIssue, { code: "unrecognized_keys" }>;

function unknownKeys(issues: readonly z.core.$ZodIssue[]): UnknownKeys[] | null {
  const additions: UnknownKeys[] = [];
  for (const issue of issues) {
    if (issue.code === "unrecognized_keys") additions.push(issue);
    else if (issue.code === "invalid_union") {
      // An otherwise-valid union member can differ only in newly added fields.
      const compatible = issue.errors.map(unknownKeys).find((keys) => keys !== null);
      if (!compatible) return null;
      additions.push(...compatible);
    } else return null;
  }
  return additions;
}

/** An unknown event type is a no-op; a malformed known event still fails validation. */
export function isUnknownSocketEvent(value: unknown, knownTypes: z.ZodType<string>): boolean {
  return typeof value === "object" && value !== null && "type" in value
    && typeof value.type === "string" && !knownTypes.safeParse(value.type).success;
}
