/**
 * How an answer says what it used.
 *
 * The renderer turns two ordinary Markdown constructs into affordances: a link
 * with a `resource://` target becomes an inline chip, and a GFM footnote whose
 * definition is one paragraph carrying a single recognised link becomes a
 * numbered pill with a popover. This is the half that gets them written.
 *
 * Three choices here are not style:
 *
 * - **The announcement rule lives in `DOCUMENT_GENERATION_POLICY`, not here.**
 *   The embed form (`![Title](resource://<id>)`) is how a run announces a
 *   document it published. Keeping it there rather than here leaves one rule
 *   for that act: the documents section owns when to publish and how to
 *   announce, and this section owns how to cite what is already in context.
 * - **Never fabricating an identifier is the whole defense**, and it is stated
 *   once, as an action rather than a second prohibition. Platform policy
 *   already forbids inventing an identifier twice over; what was missing was
 *   what to do instead, and "ask a person" — the remedy the working-style rule
 *   gives — is not available to a headless run.
 * - **The footnote grammar names the targets it accepts.** The renderer lifts a
 *   definition only when its one link resolves to a scheme it knows, so
 *   guidance that said "exactly one link" and stopped produced footnotes that
 *   silently rendered classic, with the trailing list this feature exists to
 *   remove.
 *
 * This renders for every work-stream run — interactive, automation and
 * scheduled digest alike, since they share one system prompt. The meeting
 * prompts compose the response-formatting policy separately and do not get it,
 * which is right: they have no resource identifiers in context.
 *
 * Rollback is deleting this from the prompt. Everything already sent keeps
 * rendering, because the renderer reads the message text and nothing else.
 */
export const CITATION_POLICY = `# Citations

You have the choice of three types of citations inline, embedded, or footnote. Use inline (markdown link form) when you can link a certain specific phrase, substring, or quote to the source document in a link format. Use embedded citations (markdown image form) when you want to provide a card that shows a preview of the resource (images, highlighted documents, etc) and interrupt 2 paragraphs. **Never** place an embedded citation in the middle of a sentence or paragraph. Use a footnote citation (footnote Markdown form) when the entire sentence or entire paragraph is grounded by the source. **Always** put a footnote citation at the end of a sentence.

Person mentions **always** use link Markdown form \`[@Display Name](person://<person-id>)\`.

Write a footnote definition as exactly one link — targeting a resource:// identifier or an https:// URL — with optional words around it. A definition with no link, with two, with a target of any other kind, or running to a second paragraph is a plain footnote, not a citation.

Cite the sources an answer actually leans on, not everything you touched. An answer that rests on nothing in this run's context carries no citations.

`;
