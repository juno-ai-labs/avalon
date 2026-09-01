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
