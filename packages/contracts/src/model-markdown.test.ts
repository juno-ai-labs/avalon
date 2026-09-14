import "../../../tests/isolated-region";
import { describe, expect, it } from "vitest";
import { normalizeModelMarkdown, normalizeModelText } from "./model-markdown";

describe("normalizeModelMarkdown", () => {
  it("turns a delimited arrow command into the arrow the model meant", () => {
    expect(normalizeModelMarkdown("Backlog $\\rightarrow$ In progress $\\rightarrow$ Done"))
      .toBe("Backlog → In progress → Done");
  });

  it("reads every delimiter TeX offers, not only dollars", () => {
    expect(normalizeModelMarkdown("Rate is \\(x \\to y\\) per hour")).toBe("Rate is x → y per hour");
    expect(normalizeModelMarkdown("Total:\n\\[3 \\times 4\\]")).toBe("Total:\n3 × 4");
    expect(normalizeModelMarkdown("$$\\text{ARR} = \\text{MRR} \\times 12$$")).toBe("ARR = MRR × 12");
  });

  it("leaves money alone, because a dollar sign is not a delimiter", () => {
    expect(normalizeModelMarkdown("Plans cost $50 and $70 per seat."))
      .toBe("Plans cost $50 and $70 per seat.");
    expect(normalizeModelMarkdown("Revenue moved from $1.2M to $4M this year."))
      .toBe("Revenue moved from $1.2M to $4M this year.");
  });

  it("unwraps TeX's punctuation escapes so an identifier reads as itself", () => {
    // The underscore comes back escaped: it is literal text now, and Markdown
    // would otherwise take it as the start of an emphasis run.
    expect(normalizeModelMarkdown("Column $user\\_id$ is the key."))
      .toBe("Column user\\_id is the key.");
  });

  it("maps sub- and superscripts a reader can actually see", () => {
    expect(normalizeModelMarkdown("Handles $10^{6} \\times 3$ rows with $x_1 \\ne 0$ set."))
      .toBe("Handles 10⁶ × 3 rows with x₁ ≠ 0 set.");
  });

  it("escapes a subscript that has no character of its own, rather than italicizing the line", () => {
    expect(normalizeModelMarkdown("Use $a_{key} \\ne b_{key}$ here."))
      .toBe("Use a\\_key ≠ b\\_key here.");
  });

  // The rule that keeps money intact is the same rule that keeps these intact,
  // and this is the case that decides it: a span with `_` but no backslash is
  // far more often two shell variables than it is a subscript.
  it("leaves environment variables alone, dollars and underscores and all", () => {
    expect(normalizeModelMarkdown("Set $DATABASE_URL and $API_KEY before the run."))
      .toBe("Set $DATABASE_URL and $API_KEY before the run.");
  });

  it("does not read a bare superscript between two prices as math", () => {
    expect(normalizeModelMarkdown("Tiers are $10^ and $20^ per user."))
      .toBe("Tiers are $10^ and $20^ per user.");
  });

  it("recognises a command the model wrote with no delimiters at all", () => {
    expect(normalizeModelMarkdown("Draft \\rightarrow Review \\rightarrow Ship"))
      .toBe("Draft → Review → Ship");
  });

  it("leaves a Markdown escape as the escape it already is", () => {
    expect(normalizeModelMarkdown("The file is named report\\_final.md"))
      .toBe("The file is named report\\_final.md");
    expect(normalizeModelMarkdown("A literal \\*asterisk\\* stays put."))
      .toBe("A literal \\*asterisk\\* stays put.");
  });

  it("never rewrites a fenced block, which may be showing TeX on purpose", () => {
    const source = "Before $\\times$ after\n\n```tex\n$\\rightarrow$ \\times\n```\n\nAfter $\\times$ again";
    expect(normalizeModelMarkdown(source))
      .toBe("Before × after\n\n```tex\n$\\rightarrow$ \\times\n```\n\nAfter × again");
  });

  it("never rewrites an inline code span", () => {
    expect(normalizeModelMarkdown("Run `git log --format=$\\rightarrow$` then $\\times$ two"))
      .toBe("Run `git log --format=$\\rightarrow$` then × two");
  });

  it("leaves an unterminated fence's contents alone to the end of the text", () => {
    expect(normalizeModelMarkdown("Head\n\n```\n$\\times$\nstill code"))
      .toBe("Head\n\n```\n$\\times$\nstill code");
  });

  it("shows an unknown command as a word rather than as a stray backslash", () => {
    expect(normalizeModelMarkdown("Coil is $12 \\ohm$ nominal.")).toBe("Coil is 12 ohm nominal.");
  });

  it("keeps an unknown command's operands apart instead of running them into one word", () => {
    // `fracab` reads as Avalon garbling a word; `frac a b` reads as the
    // unrendered math it is — which is the failure the module prefers.
    expect(normalizeModelMarkdown("Ratio \\[ \\frac{a}{b} \\] here")).toBe("Ratio frac a b here");
  });

  it("is idempotent, so a surface that normalizes twice is not a bug", () => {
    const once = normalizeModelMarkdown("Backlog $\\rightarrow$ Done, $a_{key}$, cost $40");
    expect(normalizeModelMarkdown(once)).toBe(once);
  });

  it("returns text with no TeX in it untouched", () => {
    const source = "# Heading\n\n- One **bold** item\n- A [link](https://example.com)\n\n| a | b |\n| - | - |\n| 1 | 2 |";
    expect(normalizeModelMarkdown(source)).toBe(source);
  });

  it("does not treat a lone dollar pair spanning a line break as math", () => {
    expect(normalizeModelMarkdown("Budget is $40\nand \\times is separate"))
      .toBe("Budget is $40\nand × is separate");
  });

  it("maps the comparison commands models actually reach for", () => {
    expect(normalizeModelMarkdown("Fails when $x \\lt y$ or $y \\gt z$"))
      .toBe("Fails when x \\< y or y \\> z");
    expect(normalizeModelMarkdown("Proof $A \\Longrightarrow B$")).toBe("Proof A ⇒ B");
  });

  // The delimited pass pairs the first two dollars it sees, so a price eats
  // the opening delimiter of the real span and the bare pass repairs what is
  // left inside the orphaned pair. The stray delimiters are the documented
  // cost of the money guard — this pins the artifact as a known one.
  it("repairs the command in a money-and-TeX sentence, leaving the orphaned dollars", () => {
    expect(normalizeModelMarkdown("Costs $50 and moves $\\rightarrow$ done"))
      .toBe("Costs $50 and moves $→$ done");
  });

  it("leaves a backslash inside a path or hyphenation alone, repairing only a standalone token", () => {
    expect(normalizeModelMarkdown("Migrate C:\\to\\dist keeps \\in-flight work"))
      .toBe("Migrate C:\\to\\dist keeps \\in-flight work");
  });

  it("does not unwrap its own escaped output as a second bracket span", () => {
    // `escapeForMarkdown` writes `\[…\]` around what it unwrapped; a second
    // pass reading that back as display math would eat the brackets.
    const once = normalizeModelMarkdown("$\\text{[a\\_b]}$");
    expect(once).toBe("\\[a\\_b\\]");
    expect(normalizeModelMarkdown(once)).toBe(once);
  });
});

describe("normalizeModelText", () => {
  it("maps the same commands for a surface that parses no Markdown", () => {
    expect(normalizeModelText("Migrate billing $\\rightarrow$ Stripe")).toBe("Migrate billing → Stripe");
  });

  it("adds no escapes, because a backslash here is one the reader sees", () => {
    // The Markdown entry point escapes this underscore; a title has no parser
    // to protect from it, only a person reading it.
    expect(normalizeModelText("Rename $user\\_id$ column")).toBe("Rename user_id column");
    expect(normalizeModelMarkdown("Rename $user\\_id$ column")).toBe("Rename user\\_id column");
  });

  it("keeps the same guard around money", () => {
    expect(normalizeModelText("Raise the $50 tier")).toBe("Raise the $50 tier");
  });

  it("returns text with no TeX in it untouched", () => {
    expect(normalizeModelText("Q3 planning for the enterprise region")).toBe("Q3 planning for the enterprise region");
  });

  // This surface is one of the two that *store* the result, so a false
  // positive here outlives the render that made it: a title with a Windows
  // path or a hyphenated word must come back exactly as written.
  it("leaves a backslash inside a path or hyphenation alone on the stored surfaces", () => {
    expect(normalizeModelText("Migrate C:\\to\\dist and \\in-flight work"))
      .toBe("Migrate C:\\to\\dist and \\in-flight work");
  });
});

/**
 * This pass sits between the model and every renderer, so it is the one place
 * that could mangle a citation before anything has had a chance to read it. It
 * escapes Markdown punctuation in what it unwraps, and a `\[` manufactured
 * inside a citation would stop the syntax being a link at all — the failure
 * would look like the citation feature not working, several modules away from
 * the cause.
 */
describe("citation syntax through the normalizer", () => {
  it("passes every citation form through byte for byte", () => {
    for (const source of [
      "See [the Q3 deck](resource://board-deck) for detail.",
      "![Mute windows PRD](resource://prd-mute)",
      "Revenue grew 40%.[^1]\n\n[^1]: [Q3 board deck](resource://board-deck)",
      "Legacy spelling still parses: [Deck](resource:board-deck).",
      "[Docs](https://example.com/a_b_c?x=1&y=2)",
    ]) {
      expect(normalizeModelMarkdown(source)).toBe(source);
    }
  });

  it("still repairs the prose around a citation", () => {
    expect(normalizeModelMarkdown("Backlog $\\rightarrow$ Done, per [the deck](resource://d)."))
      .toBe("Backlog → Done, per [the deck](resource://d).");
  });
});
