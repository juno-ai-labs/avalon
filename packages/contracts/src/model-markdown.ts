/**
 * Turning a model's TeX habit back into text.
 *
 * Every model Avalon routes to writes Markdown, and several of them reach for
 * TeX when they want a symbol: `Backlog $\rightarrow$ Done` instead of
 * `Backlog → Done`. Nothing downstream renders TeX — not the desktop's
 * Markdown renderer, not the digest email, not Slack — so the delimiters and
 * the command name are shown to the reader verbatim. This maps the small,
 * closed set of commands that actually appear in work prose onto the Unicode
 * characters the model meant, and leaves everything else alone.
 *
 * Two rules decide what is touched, and both exist to stop this from doing
 * damage of its own:
 *
 * - **A `$…$` span is math only if it contains a backslash command.** `$50 and
 *   $70 per seat` is a sentence about money that a dollar-delimiter rule reads
 *   as math, and money is far more common in this product than algebra. The
 *   backslash is what distinguishes the two, so it is what is required.
 * - **Code is never touched.** A fenced block or an inline span may be showing
 *   TeX on purpose, and rewriting a code sample is worse than the symptom.
 *
 * Unwrapped math becomes *literal text* that is then parsed as Markdown, so
 * every character that Markdown would act on is escaped on the way out — a
 * subscript that mapped to `_` would otherwise italicize the rest of the line.
 *
 * This is a display repair, not a rewrite of what the model said: the stored
 * message keeps its original bytes, and every surface calls this on the way to
 * a reader. That also keeps the mention offsets computed against the stored
 * text valid, which they would not be if this ran before they were resolved.
 */

import { mapMarkdownProse } from "./markdown-code";

/**
 * Commands worth mapping: the arrows, comparisons and operators that turn up in
 * a status update or a metric. Anything outside this list is left as the model
 * wrote it, because a wrong symbol reads as fact and a visible `\ohm` reads as
 * a glitch — and only one of those is reported.
 */
const COMMAND_TO_CHARACTER: Readonly<Record<string, string>> = {
  to: "→",
  rightarrow: "→",
  longrightarrow: "→",
  Rightarrow: "⇒",
  Longrightarrow: "⇒",
  implies: "⇒",
  gets: "←",
  leftarrow: "←",
  longleftarrow: "←",
  Leftarrow: "⇐",
  Longleftarrow: "⇐",
  leftrightarrow: "↔",
  Leftrightarrow: "⇔",
  iff: "⇔",
  uparrow: "↑",
  downarrow: "↓",
  mapsto: "↦",
  times: "×",
  div: "÷",
  cdot: "·",
  pm: "±",
  mp: "∓",
  ast: "*",
  star: "★",
  bullet: "•",
  circ: "∘",
  leq: "≤",
  le: "≤",
  lt: "<",
  geq: "≥",
  ge: "≥",
  gt: ">",
  neq: "≠",
  ne: "≠",
  equiv: "≡",
  approx: "≈",
  sim: "~",
  simeq: "≃",
  propto: "∝",
  ll: "≪",
  gg: "≫",
  infty: "∞",
  partial: "∂",
  sum: "∑",
  prod: "∏",
  int: "∫",
  sqrt: "√",
  angle: "∠",
  degree: "°",
  percent: "%",
  perthousand: "‰",
  pounds: "£",
  euro: "€",
  yen: "¥",
  copyright: "©",
  textregistered: "®",
  dots: "…",
  ldots: "…",
  cdots: "⋯",
  vdots: "⋮",
  quad: " ",
  qquad: "  ",
  space: " ",
  emdash: "—",
  endash: "–",
  checkmark: "✓",
  in: "∈",
  notin: "∉",
  subset: "⊂",
  subseteq: "⊆",
  supset: "⊃",
  supseteq: "⊇",
  cup: "∪",
  cap: "∩",
  emptyset: "∅",
  forall: "∀",
  exists: "∃",
  neg: "¬",
  land: "∧",
  lor: "∨",
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  varepsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  pi: "π",
  rho: "ρ",
  sigma: "σ",
  tau: "τ",
  upsilon: "υ",
  phi: "φ",
  varphi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
};

/**
 * TeX's escapes for characters that are punctuation in prose. Kept separate
 * from the command map because these are only ever unescaped inside math — a
 * bare `\_` in Markdown is already an escape doing its job, and rewriting it
 * would change text nobody complained about.
 */
const ESCAPED_PUNCTUATION: Readonly<Record<string, string>> = {
  "\\": "",
  _: "_",
  "%": "%",
  $: "$",
  "&": "&",
  "#": "#",
  "{": "{",
  "}": "}",
  " ": " ",
};

/** Wrappers whose only contribution is a typeface the reader will never see. */
const TRANSPARENT_WRAPPERS = new Set([
  "text",
  "textrm",
  "textbf",
  "textit",
  "texttt",
  "textsf",
  "mathrm",
  "mathbf",
  "mathit",
  "mathtt",
  "mathsf",
  "mathcal",
  "mathbb",
  "operatorname",
  "displaystyle",
  "textstyle",
  "left",
  "right",
]);

const SUPERSCRIPTS: Readonly<Record<string, string>> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
  "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ",
};

const SUBSCRIPTS: Readonly<Record<string, string>> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
  "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
};

/** Characters Markdown acts on, escaped so unwrapped math stays literal. */
const MARKDOWN_ACTIVE = /[\\`*_[\]<>&~|#]/gu;

function escapeForMarkdown(value: string): string {
  return value.replace(MARKDOWN_ACTIVE, (character) => `\\${character}`);
}

/**
 * Whether a delimited span is math rather than prose that happens to sit
 * between two dollar signs. A backslash is the whole test: it is what every
 * command, escape and wrapper starts with, and what no amount of money has.
 */
function looksLikeMath(body: string): boolean {
  return /\\[A-Za-z]|\\[\\_%$&#{} ]/u.test(body);
}

/**
 * One TeX body rendered as the plain characters it stood for.
 *
 * Unrecognised commands keep their name without the backslash — `\ohm` becomes
 * `ohm` — because the alternative is showing the reader a stray backslash that
 * looks like corruption. A command this list should know is a gap to fill in
 * the map above, and reads as one.
 */
function texToPlainText(body: string): string {
  let value = body;
  // Wrappers first: their braces have to go before the brace stripper below
  // reaches them, or `\text{a b}` loses the space its braces were holding.
  value = value.replace(
    /\\([A-Za-z]+)\s*\{([^{}]*)\}/gu,
    (match, command: string, inner: string) => (TRANSPARENT_WRAPPERS.has(command) ? inner : match),
  );
  value = value.replace(/\\([A-Za-z]+)(?![A-Za-z])/gu, (_match, command: string) => (
    COMMAND_TO_CHARACTER[command] ?? command
  ));
  value = value.replace(/\\([\\_%$&#{} ])/gu, (_match, character: string) => (
    ESCAPED_PUNCTUATION[character] ?? character
  ));
  value = value.replace(/([_^])\{([^{}]*)\}|([_^])(\S)/gu, (
    match,
    bracedMarker: string | undefined,
    braced: string | undefined,
    bareMarker: string | undefined,
    bare: string | undefined,
  ) => {
    const marker = bracedMarker ?? bareMarker ?? "";
    const target = braced ?? bare ?? "";
    const table = marker === "^" ? SUPERSCRIPTS : SUBSCRIPTS;
    const mapped = [...target].map((character) => table[character]);
    return mapped.length > 0 && mapped.every((character) => character !== undefined)
      ? mapped.join("")
      : match;
  });
  // Grouping braces carry no meaning once the commands they grouped are gone —
  // but their *boundaries* often do. `\frac{a}{b}` has already become
  // `frac{a}{b}` by here, and deleting the braces outright runs the operands
  // into one nonsense word, `fracab`, which reads as Avalon garbling a word
  // rather than as unrendered math. A brace pair closing against the next, or
  // opening after a word, becomes a space; a brace against punctuation (the
  // subscript case `a_{key}`, already handled above) is simply dropped.
  value = value.replace(/\}\{/gu, " ");
  value = value.replace(/([A-Za-z0-9])\{/gu, "$1 ");
  value = value.replace(/[{}]/gu, "");
  return value.replace(/\s+/gu, " ").trim();
}

/**
 * `$…$`, `$$…$$`, `\(…\)` and `\[…\]`. Only the single-dollar form refuses a
 * newline — that is what keeps a price at the end of one line from pairing
 * with a price on the next; the explicit delimiters have no such ambiguity.
 */
const MATH_SPAN = /\$\$([^$]+?)\$\$|\$([^$\n]+?)\$|\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]/gu;

/**
 * An inline code span: a run of backticks closed by a run of the same length.
 *
 * Whole lines of code — fenced and indented blocks alike — are
 * [`markdown-code.ts`](markdown-code.md)'s answer, shared with every other
 * rewriter here so none of them can disagree about where a block ends. Spans
 * are this module's own, because the other rewriter that skips them parks one
 * inside a line rather than splitting prose at it. Splitting on both is what
 * keeps the rewriter out of code — the alternative, a rule clever enough to
 * recognise code mid-replacement, is the kind that fails on the first sample
 * containing a dollar sign.
 */
const CODE_SPAN = /(`+)([\s\S]*?)\1/gu;

/** A run of prose with its code spans stepped over, and everything else repaired. */
function normalizeOutsideCodeSpans(value: string, escape: (plain: string) => string): string {
  let result = "";
  let cursor = 0;
  CODE_SPAN.lastIndex = 0;
  for (let match = CODE_SPAN.exec(value); match !== null; match = CODE_SPAN.exec(value)) {
    result += normalizeProse(value.slice(cursor, match.index), escape);
    result += match[0];
    cursor = match.index + match[0].length;
  }
  return result + normalizeProse(value.slice(cursor), escape);
}

/**
 * A run of prose with its TeX turned back into the characters it stood for.
 *
 * `escape` is what separates the two entry points below. Unwrapped math is
 * literal text, and on a Markdown surface literal text has to be escaped or an
 * underscore starts an emphasis run; on a plain-text surface the same escape is
 * a backslash the reader sees.
 */
function normalizeProse(value: string, escape: (plain: string) => string): string {
  let result = value.replace(MATH_SPAN, (match, display?: string, inline?: string, paren?: string, bracket?: string) => {
    const body = display ?? inline ?? paren ?? bracket;
    if (body === undefined) return match;
    // The `\(…\)` and `\[…\]` forms demand a real command, not merely a
    // punctuation escape: `escapeForMarkdown` writes `\[` and `\]` itself, so
    // a body whose only backslashes are escapes is this function's own output
    // being read back — unwrapping it a second time eats the brackets, which
    // is exactly the non-idempotence the invariant forbids.
    const isMath = paren !== undefined || bracket !== undefined
      ? /\\[A-Za-z]/u.test(body)
      : looksLikeMath(body);
    if (!isMath) return match;
    const plain = texToPlainText(body);
    return plain.length > 0 ? escape(plain) : match;
  });
  // Commands the model wrote without any delimiters around them at all. Only
  // the named ones, never the punctuation escapes (`\_` outside math is a
  // Markdown escape already doing exactly what it says), and only standing as
  // their own token — beginning after a space, a bracket, or an orphaned `$`,
  // and ending before space, closing punctuation, or the end. Without the
  // boundary, `C:\to\dist` is a path with an arrow in it and `\in-flight` is a
  // hyphenation with a set operator — and two call sites *store* what this
  // returns, where a wrong repair outlives the render that made it.
  result = result.replace(
    /(?<=^|[\s([{$])\\([A-Za-z]+)(?=$|[\s)\]}$.,;:!?])/gu,
    (match, command: string) => {
      const character = COMMAND_TO_CHARACTER[command];
      return character === undefined ? match : escape(character);
    },
  );
  return result;
}

/**
 * The Markdown a reader should see, given the Markdown a model wrote.
 *
 * Idempotent: its own output contains no TeX, so a surface that calls it twice
 * gets the same string. Safe on text that contains none, which is most of it —
 * the common path is one regex scan that matches nothing.
 */
export function normalizeModelMarkdown(value: string): string {
  if (!value.includes("\\") && !value.includes("$")) return value;
  return mapMarkdownProse(value, (prose) => normalizeOutsideCodeSpans(prose, escapeForMarkdown));
}

/**
 * The same repair for a surface that renders no Markdown at all — a work-stream
 * title, an elicitation's question, a menu row, a notification.
 *
 * Two differences follow from there being no parser downstream. Nothing is
 * escaped, because a backslash added here is a backslash the reader sees. And
 * code is not skipped, because there are no code spans to skip: backticks on
 * such a surface are punctuation, and a model that wrote `$\times$` into a
 * title meant the character there just as much as it did in a paragraph.
 */
export function normalizeModelText(value: string): string {
  if (!value.includes("\\") && !value.includes("$")) return value;
  return normalizeProse(value, (plain) => plain);
}
