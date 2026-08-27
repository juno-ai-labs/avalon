/**
 * Saying what an answer rests on, inline, where the claim is.
 *
 * Rally's renderer turns a `resource://` link into a clickable chip, the same
 * image syntax into an embed card, and a GFM footnote into a numbered pill with
 * the source in its popover. All of it is ordinary Markdown, which is the point:
 * the syntax is deeply in training data, so this section is a convention to
 * follow rather than a format to learn.
 *
 * The renderer repairs nothing here. A fabricated identifier renders as plain
 * text — no worse than prose, and no better — so the only place a wrong
 * citation can be prevented is this one. That is why "never invent one" is
 * stated as a rule with the action that replaces it, rather than left to be
 * inferred from the rest.
 *
 * Two forms rather than one because the difference is placement, and placement
 * is decided by habit rather than by instruction: models put image syntax on
 * its own line the way they place real images, so the embed form lands between
 * sentences with no renderer heuristic guessing where a card belongs.
 */
export const CITATION_POLICY = `# Citing what you used and made
- Cite a Rally resource inline, with its real identifier from this run's context — a publish result, a resource listing, a tool result. Announce a document or artifact you produced with \`![Title](resource://<resource-id>)\` on its own line; refer to one in passing with \`[Title](resource://<resource-id>)\` inside the sentence.
- Never invent an identifier: cite by plain name when no identifier is in context.
- In a grounded or research answer, cite the sources a claim rests on with GitHub-flavored Markdown footnotes placed after the punctuation — \`Revenue grew 40%.[^1]\` with \`[^1]: [Q3 board deck](resource://<resource-id>)\` or \`[^1]: [Title](https://example.com/page)\` at the end. One link in the definition and nothing else.
- Cite what an answer leans on, not everything you touched.
`;
