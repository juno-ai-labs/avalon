import { codeShaped, zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";

import { ApiError } from "./api-error";

/**
 * The code a rejected fan-out call is logged under: an `ApiError`'s own code, a
 * schema rejection with the field it rejected, and otherwise the error's name.
 */
export function settledFailureCode(reason: unknown, label: string): string {
  if (reason instanceof ApiError) return reason.diagnosticCode ?? reason.code;
  return zodDiagnosticCode(reason, label) ?? codeShaped(reason instanceof Error ? reason.name : "unknown");
}
