import { z } from "zod/v3";

/**
 * Zod v3 treats a direct `z.unknown()` object property as optional. Rejecting
 * `undefined` keeps JSON and durable/RPC object fields required as they were
 * under Zod v4; JSON cannot represent an explicitly undefined property.
 */
// This is intentionally every value except `undefined`; TypeScript has no
// dedicated "defined unknown" type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type DefinedUnknown = {} | null;

export const RequiredUnknownSchema = z.custom<DefinedUnknown>(
  (value) => value !== undefined,
  { message: "Required" },
);

const STRICT_OFFSET_SUFFIX_PATTERN = /(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u;

/** Startup-efficient offset-aware ISO datetime schema with Zod v4 semantics. */
export const OffsetDateTimeSchema = z.string()
  .datetime({ offset: true })
  .refine((value) => STRICT_OFFSET_SUFFIX_PATTERN.test(value), "Invalid datetime");
