/**
 * Appended when a first summary ran past the model's output limit and was
 * thrown away. It asks for the same sections in less space rather than fewer
 * sections, because a summary missing a section is missing it forever, while a
 * terser one merely reads worse.
 */
export const COMPACTION_SUMMARY_RETRY_SUFFIX = `

The previous attempt ran past the output limit and was discarded. Write a shorter one: keep every section that has content, cut elaboration and repetition, and prefer a terse bullet to a sentence. Keep identifiers and instructions exact — shorten the prose around them, never the facts.`;
