/**
 * How an answer says what it used and what it made.
 *
 * The renderer turns three ordinary Markdown constructs into affordances: a
 * link with a `resource://` target becomes an inline chip, an image with one
 * becomes an embedded card, and a GFM footnote whose definition carries a
 * single link becomes a numbered pill with a popover. This is the half that
 * gets them written in the first place.
 *
 * Two choices here are not style, and undoing either quietly breaks something:
 *
 * - **The embed form is taught for announcements because of where models put
 *   image syntax, not because of how it looks.** Models place an image on its
 *   own line by training, the way they place actual images, so the card lands
 *   between sentences instead of cutting one into three. The syntax does the
 *   placement work; nothing in the renderer guesses where a block belongs.
 * - **Never fabricating an identifier is the whole defense.** A citation to an
 *   invented id degrades to its label text, so a fabricated one is not
 *   dangerous — it is merely a chip that never appears, which reads to a
 *   person as the feature being broken. The instruction to cite by plain name
 *   when nothing is in context is what keeps that from being the common case.
 *
 * This renders for every participant-triggered work-stream run, with no
 * per-origin carve-outs. An answer that goes out by email or Slack still keeps
 * its citations in the transcript copy, which renders them fully; the delivery
 * rewrites own what those surfaces send. Excluding email- or Slack-origin runs
 * would need a run-origin field the prompt context does not carry, and would
 * strip citations from the copy that can actually show them.
 *
 * Rollback is deleting this from the prompt. Everything already sent keeps
 * rendering, because the renderer reads the message text and nothing else.
 */
export const CITATION_POLICY = `# Citing what you used and made
- Announce a document or artifact you produced with the embed form on its own line: \`![Title](resource://<resource-id>)\`.
- Refer to a resource in passing with the link form, inside the sentence: \`[Title](resource://<resource-id>)\`.
- Use the resource's real identifier from this run's context — publish results and resource listings carry them — and its human title as the label.
- **Never** invent a resource identifier. When you have no identifier in context, name the thing in plain words instead; a made-up one renders as plain text and reads to a person as a broken link.
- For grounded and research answers, cite sources with GitHub-flavored footnotes placed after the punctuation: \`Revenue grew 40%.[^1]\` with \`[^1]: [Q3 board deck](resource://<resource-id>)\` at the end. A source outside Rally takes its ordinary URL: \`[^2]: [The article](https://example.com/article)\`.
- Write a footnote definition as exactly one link with optional words around it. A definition with no link, with two, or running to a second paragraph is a plain footnote, not a citation.
- Cite the sources an answer actually leans on, not everything you touched.
`;
