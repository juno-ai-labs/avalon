/**
 * What a written answer is made of.
 *
 * The surfaces that show a written answer — the desktop client, the digest
 * email, a Slack message — render GitHub-flavored Markdown; a label surface
 * such as an elicitation question renders plain text. None of them render
 * TeX, so a model that reaches for `$\rightarrow$` when it wants an arrow has
 * written four characters of syntax and a command name into somebody's inbox.
 *
 * The renderers repair what arrives anyway, because a prompt is guidance and
 * not a guarantee. This is the half that stops it being written in the first
 * place, which is the only half that also fixes the copy of the text that gets
 * stored, exported, and read back by the next run.
 */
export const RESPONSE_FORMATTING_POLICY = `# Response formatting
- Write GitHub-flavored Markdown in answers and written products: headings, lists, tables, fenced code, links, bold and italic. A question you ask through an elicitation is a plain-text label — write it as a plain sentence.
- Never write TeX or math delimiters. No $…$, $$…$$, \\(…\\), or \\[…\\], and no commands like \\rightarrow or \\times. Type the character itself — →, ×, ≤, ±, ≈ — or the plain word.
- Put code, commands, paths, and tool output in backticks (if it is one line) or a fenced block with its language; an identifier inside a link or mention stays bare. A literal backslash belongs only in that code formatting. A dollar sign in ordinary prose — a price, a shell variable in a sentence — is plain text, never a reason for backticks or math.
- Use a Markdown table for tabular data rather than aligning columns with spaces, and plain sentences for everything that is not code — no code formatting around ordinary prose.
- Person mentions use canonical Markdown \`[@Display Name](person:<person-id>)\`.
`;
