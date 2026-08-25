import type { DerivativeStatus } from "@rally/contracts";

export interface AttachmentDerivativeStateRow {
  modelContentStatus: DerivativeStatus;
  contentRef: string | null;
  modelContentRef: string | null;
  modelMimeType: string | null;
}

/**
 * Rows created before lifecycle state was introduced are interpreted lazily.
 * A persisted, model-native image remains usable; everything else with original
 * bytes starts extraction on first authorized use instead of requiring a
 * regional backfill. An absent original is a failure, never an empty file.
 */
export function effectiveDerivativeState(row: AttachmentDerivativeStateRow): Exclude<DerivativeStatus, null> {
  if (row.modelContentStatus) return row.modelContentStatus;
  if (row.modelContentRef && row.modelMimeType?.toLowerCase().startsWith("image/")) return "ready";
  return row.contentRef ? "pending" : "failed";
}
