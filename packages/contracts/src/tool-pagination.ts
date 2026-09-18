/** Private continuation data. Never serialize this into a model tool result. */
export interface ToolPageContinuation {
  /** Canonical operation to resume, fixed by the authored executor. */
  operation: string;
  input: Record<string, unknown>;
  /** Output slot authored by the executor, not discovered by JSON inspection. */
  slot: "nextPageId" | "previousPageId" | "readPageId";
  passageIndex?: number;
  citationIndex?: number;
}

export interface ToolPaginationResult {
  continuations: ToolPageContinuation[];
}
