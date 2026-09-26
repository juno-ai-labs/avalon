import { WORKSTREAM_ICON_DESCRIPTIONS, WORKSTREAM_ICON_KEYS } from "@rally/contracts";

/**
 * The icon catalog as a model reads it: one line per icon, in the catalog's own
 * order.
 *
 * Rendered from the shared catalog rather than written out at each prompt: an
 * icon a person can pick and an icon a model can choose are the same closed
 * set, for a Channel, a Breakout and a Sidekick alike, and a second copy in
 * prose is one nothing checks. The order is the exported array's, which is
 * deterministic, so every prompt that carries it stays byte-stable across
 * renders the way [`writing-prompts.md`](../../../../docs/writing-prompts.md)
 * requires.
 *
 * Each line is a description of a drawing and carries no guidance about when to
 * use it. That is deliberate: the model has the request and the whole catalog,
 * which is more than the catalog's author had, so the matching is left to it.
 */
export const WORKSTREAM_ICON_CATALOG = WORKSTREAM_ICON_KEYS
  .map((key) => `- ${key}: ${WORKSTREAM_ICON_DESCRIPTIONS[key]}`)
  .join("\n");
