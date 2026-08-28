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
 *   document it published, and that section is gated on the run actually being
 *   able to publish one. Teaching it here charged every automation, scheduled
 *   digest, inbound-email and Slack-origin run to announce documents they were
 *   deliberately never told to make — and on the Slack path the delivery
 *   rewrite reduces such a line to a bare title with nothing to open, which is
 *   the exact outcome that gate exists to prevent. It also left two rules for
 *   one act with no tie-break between them.
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
- Refer to a resource with the link form, inside the sentence: \`[Title](resource://<resource-id>)\`. Label it with the resource's human title, and target it with the identifier a tool result in this run returned for that resource. With no identifier in context, name the thing in plain words rather than citing it.
- A source that backs a specific claim takes a GitHub-flavored footnote after that claim's punctuation instead: \`Revenue grew 40%.[^1]\` with \`[^1]: [Q3 board deck](resource://<resource-id>)\` at the end. A source outside Rally takes its ordinary URL: \`[^2]: [The article](https://example.com/article)\`.
- Write a footnote definition as exactly one link — targeting a resource:// identifier or an https:// URL — with optional words around it. A definition with no link, with two, with a target of any other kind, or running to a second paragraph is a plain footnote, not a citation.
- Cite the sources an answer actually leans on, not everything you touched. An answer that rests on nothing in this run's context carries no citations.
`;
