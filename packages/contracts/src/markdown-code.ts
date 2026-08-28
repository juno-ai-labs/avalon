/**
 * Which lines of a Markdown document are code, so that five rewriters agree.
 *
 * A model showing somebody Markdown syntax — how to write a citation, what a
 * `$\rightarrow$` looks like — puts it in a code block, and a rewriter that
 * edits one deletes the very thing being shown. So every rewriter here has to
 * recognise code, and none of them wants to parse Markdown to do it.
 *
 * Each had grown its own answer: `citations.ts`, the TeX repair in
 * `model-markdown.ts`, the email renderer's block parser and its plain-text
 * pass, and the desktop's streaming splitter. They were not identical, which is
 * the point. Two of them disagreeing is not a visible bug in either — it is a
 * code sample rewritten in an inbox while the prose beside it was not, or a
 * number in an email that does not match the number in the transcript.
 *
 * The classifier itself came from `citations.ts`, where three passes had
 * already been collapsed onto it; this module is that same rule, moved where
 * the other readers can reach it.
 *
 * ## The rule
 *
 * **A fenced block** opens on up to three spaces of indent and a run of three
 * or more backticks or tildes, and closes on **any run of the opener's own
 * character at least as long, whatever follows it** — where CommonMark wants
 * the closer's rest-of-line bare. That looseness is deliberate. Reaching the
 * difference means writing ```` ```more ```` inside a block opened by a run of
 * the same length, and erring loose keeps the delimiter line itself on the code
 * side, so the failure is a line left alone rather than a line rewritten. The
 * length test is what keeps the common case right: a ```` ```` ````-fenced
 * sample containing a ```` ``` ```` block stays one block.
 *
 * **An indented block** opens on four spaces or a tab and runs until a line
 * returns to the margin; a blank line inside it does not end it. The rule that
 * keeps this from going too far is that an indented chunk **cannot interrupt a
 * paragraph** — so a lazily-indented continuation line is prose, and is still
 * rewritten. Reading it as code instead would leave a real `resource://` target
 * in somebody's inbox, which is the failure the citation rewrite exists to
 * prevent, and is why the rule is not simply "four spaces".
 *
 * ## What this deliberately does not own
 *
 * **Inline code spans.** They stay with the rewriter that skips them, because
 * the two that do want different mechanics for the same idea: `citations.ts`
 * *parks* a span behind a placeholder so its line survives as a line, while
 * `model-markdown.ts` *splits* prose at one. Their patterns differ too, and
 * narrowing either to match the other changes what each rewrites. Whole lines
 * are this module's business; a span inside one is not.
 *
 * **The Slack chunker** (`@rally/connectors/slack-markdown`), which tracks
 * fences to cut a message at Slack's block limit and reopen the block in the
 * next chunk. It keeps the opening line rather than the marker, because it has
 * to replay it, and it closes only on a *bare* run — the strict reading — since
 * a fence it wrongly believes closed severs a code block in a message that has
 * already been delivered, where nothing heals it. Different question,
 * different cost, answered where it is asked.
 */

/** A fence delimiter. Group 1 is the run: the character and length a closer must reach. */
const FENCE_DELIMITER = /^ {0,3}(`{3,}|~{3,})/u;
/** The indent that opens an indented code block: four spaces, or a tab. */
const INDENTED_CODE_LINE = /^(?: {4}|\t)/u;

/** What a line is, once the classifier has read it. */
export type MarkdownLineKind =
  /** Outside code. The only kind a rewriter may touch. */
  | "prose"
  /** The delimiter that opened a fenced block. Code, not prose. */
  | "fence-open"
  /** Between a fenced block's delimiters. */
  | "fence-content"
  /** The delimiter that closed a fenced block. Code, not prose. */
  | "fence-close"
  /** A line of an indented code block, or a blank line continuing one. */
  | "indented-code";

/** Whether a rewriter must leave this line alone. */
export function isMarkdownCode(kind: MarkdownLineKind): boolean {
  return kind !== "prose";
}

/**
 * Classifies every line of a document, in order.
 *
 * Takes the whole document because both constructs are stateful: a fence runs
 * until its closer, and an indented block depends on whether a paragraph was
 * open above it.
 */
export function markdownLineKinds(lines: readonly string[]): MarkdownLineKind[] {
  const kinds: MarkdownLineKind[] = [];
  let fence: string | null = null;
  let indented = false;
  let paragraph = false;
  for (const line of lines) {
    const fenceMark = FENCE_DELIMITER.exec(line)?.[1];
    if (fence !== null) {
      if (fenceMark?.startsWith(fence[0]!) && fenceMark.length >= fence.length) {
        fence = null;
        kinds.push("fence-close");
        continue;
      }
      kinds.push("fence-content");
      continue;
    }
    if (fenceMark) {
      fence = fenceMark;
      indented = false;
      paragraph = false;
      kinds.push("fence-open");
      continue;
    }
    const blank = line.trim() === "";
    const isIndented = INDENTED_CODE_LINE.test(line);
    if (indented) {
      // A blank line does not end an indented block — an indented line after it
      // continues the same block — but a line at the margin does.
      if (blank || isIndented) {
        kinds.push("indented-code");
        continue;
      }
      indented = false;
    } else if (isIndented && !blank && !paragraph) {
      indented = true;
      kinds.push("indented-code");
      continue;
    }
    kinds.push("prose");
    paragraph = !blank;
  }
  return kinds;
}

/**
 * `value` with every run of prose passed through `transform`, and every line of
 * code — a fence's delimiters included — handed back exactly as written.
 *
 * `transform` sees a *maximal* run: consecutive prose lines arrive as one
 * string, so a construct spanning a line break is still whole for a rewrite
 * that reads one. A rewriter that works line by line splits the run itself.
 *
 * Line endings are preserved rather than normalized, and `transform` returning
 * its argument returns `value` byte for byte — the property the citation
 * rewrite's promise of an unchanged document rests on.
 */
export function mapMarkdownProse(value: string, transform: (prose: string) => string): string {
  const lines = value.split("\n");
  const kinds = markdownLineKinds(lines);
  const runs: string[] = [];
  let run: string[] = [];
  let prose = true;
  for (const [index, line] of lines.entries()) {
    const isProse = !isMarkdownCode(kinds[index]!);
    if (isProse !== prose && run.length > 0) {
      runs.push(prose ? transform(run.join("\n")) : run.join("\n"));
      run = [];
    }
    prose = isProse;
    run.push(line);
  }
  if (run.length > 0) runs.push(prose ? transform(run.join("\n")) : run.join("\n"));
  return runs.join("\n");
}
