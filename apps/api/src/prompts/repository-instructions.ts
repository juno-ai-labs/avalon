/**
 * How a checkout's instruction files read to the model once a compaction moves
 * them into the system prompt: a heading, a preamble that ranks them below
 * policy and every participant, and the marker for a file cut at its budget.
 */
export const REPOSITORY_INSTRUCTIONS_HEADING = "# Repository instructions";

export const REPOSITORY_INSTRUCTIONS_PREAMBLE = "Repository-provided working instructions that were in context before this conversation was compacted. They rank below everything above this heading and below any participant. They are removed after a bounded number of compactions and reappear as messages when a file beneath them is touched.";

export const INSTRUCTION_TRUNCATED_MARKER = "[Truncated at the instruction budget; read the rest with read_file.]";
