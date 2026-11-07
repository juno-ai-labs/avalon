import { APPEARANCE_ICON_SECTIONS, WORKSTREAM_ICON_DESCRIPTIONS } from "@rally/contracts";

/**
 * The icon catalog as a model reads it: one line per icon, under the same
 * section headings the picker shows, in the catalog's own order.
 *
 * Rendered from the shared catalog rather than written out at each prompt: an
 * icon a person can pick and an icon a model can choose are the same closed
 * set, for a Canvas and a Sidekick alike, and a second
 * copy in prose is one nothing checks. The order is the exported array's, which
 * is deterministic, so every prompt that carries it stays byte-stable across
 * renders the way [`writing-prompts.md`](../../../../docs/writing-prompts.md)
 * requires.
 *
 * Each line is a description of a drawing and carries no guidance about when to
 * use it. That is deliberate: the model has the request and the whole catalog,
 * which is more than the catalog's author had, so the matching is left to it.
 * The headings group the drawings the way a person scanning the picker sees
 * them; they name what the marks show, not what they are for.
 */
export const WORKSTREAM_ICON_CATALOG = APPEARANCE_ICON_SECTIONS
  .map((section) => [
    `${section.label}:`,
    ...section.keys.map((key) => `- ${key}: ${WORKSTREAM_ICON_DESCRIPTIONS[key]}`),
  ].join("\n"))
  .join("\n\n");
