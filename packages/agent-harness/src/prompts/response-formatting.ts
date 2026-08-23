/**
 * What a written answer is made of.
 *
 * Every surface that shows one of these answers renders GitHub-flavoured
 * Markdown and nothing else — the desktop client, the digest email, a Slack
 * message. None of them render TeX, so a model that reaches for `$\rightarrow$`
 * when it wants an arrow has written four characters of syntax and a command
 * name into somebody's inbox.
 *
 * The renderers repair what arrives anyway, because a prompt is guidance and
 * not a guarantee. This is the half that stops it being written in the first
 * place, which is the only half that also fixes the copy of the text that gets
 * stored, exported, and read back by the next run.
 */
export const RESPONSE_FORMATTING_POLICY = `# Response formatting
- Write GitHub-flavored Markdown: headings, lists, tables, fenced code, links, bold and italic. No surface renders anything else.
- Never write TeX or math delimiters. No $…$, $$…$$, \\(…\\), or \\[…\\], and no commands like \\rightarrow or \\times. Type the character itself — →, ×, ≤, ±, ≈, µ — or the plain word.
- Put code, commands, paths, identifiers, and output in backticks or a fenced block with its language. That is also the only place a literal backslash or dollar sign belongs.
- Use a Markdown table for tabular data rather than aligning columns with spaces, which no reader sees as aligned.
- Write plain sentences everywhere else. Do not escape punctuation that needs no escaping, and do not wrap ordinary prose in code formatting.`;
