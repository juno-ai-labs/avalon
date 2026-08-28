/**
 * Saying what an answer rests on, where the claim is.
 *
 * Rally's renderer turns a `resource://` link into a clickable chip and a GFM
 * footnote into a numbered pill with the source in its popover. All of it is
 * ordinary Markdown, which is the point: the syntax is deeply in training data,
 * so this section is a convention to follow rather than a format to learn.
 *
 * The renderer repairs nothing here. A fabricated identifier renders as plain
 * text — no worse than prose, and no better — so the only place a wrong
 * citation can be prevented is this one. That is why the prohibition points at
 * the listing rather than at a fallback: told only "cite by plain name when no
 * identifier is in context", a model takes that exit almost always, because the
 * resource inventory in the prefix carries counts and no identifiers at all.
 *
 * The embed form (`![Title](resource://<id>)`) is taught in
 * [`document-generation.ts`](document-generation.ts) instead, because
 * announcing a document is what that section already owns and it renders only
 * for a run that can publish one. A run that cannot publish still cites what it
 * read, which is why this section is not behind the same gate.
 */
export const CITATION_POLICY = `# Citations
- Refer to a work-stream resource inside a sentence as \`[Title](resource://<resource-id>)\`, using its real identifier from this run's context — a publish result, a resource listing, a tool result.
- Never invent an identifier. List this work stream's resources to find the real one, and refer to it by plain name only when it is not there.
- When a claim rests on a source you read — an attachment, a resource, a page you fetched — put a GitHub-flavored Markdown footnote after the punctuation and define it at the end: \`Revenue grew 40%.[^1]\` with \`[^1]: [Q3 board deck](resource://<resource-id>)\`, or an ordinary URL for an external source. One link per definition, plus at most a short phrase around it.
- Use the footnote when a source supports a claim, and the inline form above when the resource is what the sentence is about. Cite what an answer leans on, not everything you touched.
`;
