import { ZodError as ZodV4Error } from "zod";
import { ZodError as ZodV3Error } from "zod/v3";

export interface ZodValidationIssue {
  readonly code: string;
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

/** The common validation-error surface across Rally and Bind schema runtimes. */
export interface ZodValidationError {
  readonly issues: readonly ZodValidationIssue[];
}

export function isZodValidationError(error: unknown): error is ZodValidationError {
  return error instanceof ZodV3Error || error instanceof ZodV4Error;
}

const v3IssueCodeToV4 = new Map<string, string>([
  ["invalid_arguments", "invalid_type"],
  ["invalid_date", "invalid_type"],
  ["invalid_enum_value", "invalid_value"],
  ["invalid_intersection_types", "invalid_union"],
  ["invalid_literal", "invalid_value"],
  ["invalid_return_type", "invalid_type"],
  ["invalid_string", "invalid_format"],
  ["invalid_union_discriminator", "invalid_union"],
  ["not_finite", "invalid_type"],
]);

/** Keep logs and typed error envelopes on the issue-code vocabulary used before the runtime swap. */
export function normalizedZodIssueCode(code: string): string {
  return v3IssueCodeToV4.get(code) ?? code;
}
