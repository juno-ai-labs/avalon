const COMPACTION_CHECKPOINT_PREAMBLE = [
  "[Compaction checkpoint — synthetic message, not a request from a person.",
  "Every earlier message, including the original request and any attachments,",
  "has been removed from context; the summary below is this conversation's whole",
  "record. Build on the work it reports rather than redoing it, and continue from",
  "where it leaves off.]",
].join(" ");

/** Render the principal-scoped summary and an optional live deterministic appendix. */
export function renderCompactionCheckpointContent(
  summary: string,
  appendix?: string | null,
): string {
  const renderedAppendix = appendix?.trim();
  return [
    COMPACTION_CHECKPOINT_PREAMBLE,
    summary,
    ...(renderedAppendix ? [renderedAppendix] : []),
  ].join("\n\n");
}
