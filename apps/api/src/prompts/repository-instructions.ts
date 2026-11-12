/**
 * How a checkout's instruction files read to the model once a compaction moves
 * them into the system prompt: a heading, a preamble that ranks them below
 * policy and every participant, and the marker for a file cut at its budget.
 */
export const REPOSITORY_INSTRUCTIONS_HEADING = "# Repository instructions";

export const REPOSITORY_INSTRUCTIONS_PREAMBLE = "Repository-provided working instructions that were in context before this conversation was compacted. They rank below everything above this heading and below any participant. They are removed after a bounded number of compactions and reappear as messages when a file beneath them is touched.";

export const INSTRUCTION_TRUNCATED_MARKER = "[Truncated at the instruction budget; read the rest with read_file.]";

/** The line standing in for one instruction file the section could not carry. */
export function renderOmittedBlockLine(locator: string, readerTool: string): string {
  return `Omitted: ${locator} exceeds the instruction budget; read it with ${readerTool}`;
}

/** The line standing in for every omitted file, when naming each would itself not fit. */
export function renderOmittedCountLine(count: number, readerTool: string): string {
  return `Omitted: ${count} beyond the instruction budget; read them with ${readerTool}`;
}
