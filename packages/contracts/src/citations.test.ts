import { describe, expect, it } from "vitest";
import {
  citationFootnotes,
  citationScheme,
  citedResourceIds,
  connectorMentionHref,
  connectorTypeFromEmbedHref,
  connectorTypeFromMentionHref,
  embeddedResourceCitations,
  isConnectorHref,
  parseCitationHref,
  personIdFromMentionHref,
  personMentionHref,
  personMentionMarkdownPattern,
  personMentionMarkdownRanges,
  rewriteCitationsAsPlainText,
  rewriteMessageAsPlainText,
  sidekickIdFromMentionHref,
  sidekickMentionHref,
} from "./citations";

describe("parseCitationHref", () => {
  it("reads the URL-style resource scheme the guidance teaches", () => {
    expect(parseCitationHref("resource://0192f3ac-1b2c-7000-8000-abcdefabcdef")).toEqual({
      scheme: "resource",
      resourceId: "0192f3ac-1b2c-7000-8000-abcdefabcdef",
    });
  });

  it("reads the legacy bare spelling too, so nothing already emitted breaks", () => {
    expect(parseCitationHref("resource:board-deck-q3")).toEqual({
      scheme: "resource",
      resourceId: "board-deck-q3",
    });
  });

  it("accepts a slug as readily as a UUID — the id's shape is the resource system's", () => {
    expect(parseCitationHref("resource://mute-windows-prd")).toEqual({
      scheme: "resource",
      resourceId: "mute-windows-prd",
    });
  });

  it("drops a reserved version parameter rather than pretending to honour it", () => {
    // Key design decision 7: a citation opens the current version. `?v=` is
    // reserved syntax, so it must not become part of the id it would otherwise
    // fail to resolve against.
    expect(parseCitationHref("resource://board-deck?v=3")).toEqual({
      scheme: "resource",
      resourceId: "board-deck",
    });
  });

  it("refuses an identifier outside the safe alphabet", () => {
    expect(parseCitationHref("resource://../../etc/passwd").scheme).toBe("unknown");
    expect(parseCitationHref("resource://has space").scheme).toBe("unknown");
    expect(parseCitationHref("resource://").scheme).toBe("unknown");
  });

  it("names the schemes that navigate outward and the identities that never do", () => {
    expect(parseCitationHref("https://example.com/report")).toEqual({
      scheme: "external",
      url: "https://example.com/report",
    });
    expect(parseCitationHref("http://example.com")).toEqual({
      scheme: "external",
      url: "http://example.com",
    });
    expect(parseCitationHref("person:0192f3ac-1b2c-7000-8000-abcdefabcdef").scheme).toBe("person");
    expect(parseCitationHref("person://0192f3ac-1b2c-7000-8000-abcdefabcdef").scheme).toBe("person");
    // Any `person:` target is an identity, well-formed or not — it must reach
    // the cell that renders it inert rather than one that could give it a
    // destination.
    expect(parseCitationHref("person:someone").scheme).toBe("person");
    expect(parseCitationHref("person://someone").scheme).toBe("person");
  });

  it("does not treat a connector mention href as a citation scheme", () => {
    // Connector chips are render-minted mentions, not citations. Classifying
    // them here would put them in the matrix; they stay unknown to the protocol.
    expect(parseCitationHref("connector:abc123:slack").scheme).toBe("unknown");
    expect(parseCitationHref("connector://abc123:slack").scheme).toBe("unknown");
  });

  it("treats every other scheme as text, so message content reaches no protocol handler", () => {
    for (const href of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,<b>", "mailto:a@b.c", undefined]) {
      expect(parseCitationHref(href).scheme).toBe("unknown");
    }
  });
});

describe("person mention hrefs", () => {
  const id = "0192f3ac-1b2c-7000-8000-abcdefabcdef";

  it("emits the house person:// form", () => {
    expect(personMentionHref(id)).toBe(`person://${id}`);
  });

  it("reads both house and legacy spellings, and nothing else", () => {
    expect(personIdFromMentionHref(`person://${id}`)).toBe(id);
    expect(personIdFromMentionHref(`person:${id}`)).toBe(id);
    expect(personIdFromMentionHref(`PERSON://${id.toUpperCase()}`)).toBe(id);
    expect(personIdFromMentionHref("person:someone")).toBeUndefined();
    expect(personIdFromMentionHref(`person:///${id}`)).toBeUndefined();
    expect(personIdFromMentionHref(undefined)).toBeUndefined();
  });

  it("reduces both Markdown spellings to the label", () => {
    const house = `Ask [@Ada](person://${id}) please.`;
    const legacy = `Ask [@Ada](person:${id}) please.`;
    expect(house.replace(personMentionMarkdownPattern(), "@$1")).toBe("Ask @Ada please.");
    expect(legacy.replace(personMentionMarkdownPattern(), "@$1")).toBe("Ask @Ada please.");
  });

  it("locates person links in prose but not code examples", () => {
    const house = `[@Ada](person://${id})`;
    const legacy = `[@Grace](person:${id.toUpperCase()})`;
    const markdown = [
      `Ask ${house}.`,
      `Keep \`${legacy}\` literal.`,
      "```md",
      house,
      "```",
      `Then ask ${legacy}.`,
    ].join("\n");

    expect(personMentionMarkdownRanges(markdown)).toEqual([
      {
        personId: id,
        startOffset: markdown.indexOf(house),
        endOffset: markdown.indexOf(house) + house.length,
      },
      {
        personId: id,
        startOffset: markdown.lastIndexOf(legacy),
        endOffset: markdown.lastIndexOf(legacy) + legacy.length,
      },
    ]);
  });

  it("matches the rendered link grammar before granting a person range", () => {
    const link = `[@Ada](person://${id})`;
    const nested = `Plan:\n\n1. First\n\n    - Ask ${link}`;

    expect(personMentionMarkdownRanges(`Write \\${link} to show syntax.`)).toEqual([]);
    expect(personMentionMarkdownRanges(`!${link}`)).toEqual([]);
    expect(personMentionMarkdownRanges(`Use \`\` ${link} \`\` here.`)).toEqual([]);
    expect(personMentionMarkdownRanges(nested)).toEqual([{
      personId: id,
      startOffset: nested.indexOf(link),
      endOffset: nested.indexOf(link) + link.length,
    }]);
  });

  it("locates a canonical person link whose label wraps a line", () => {
    const link = `[@Ada\nLovelace](person://${id})`;
    const markdown = `Ask ${link} please.`;

    expect(personMentionMarkdownRanges(markdown)).toEqual([{
      personId: id,
      startOffset: markdown.indexOf(link),
      endOffset: markdown.indexOf(link) + link.length,
    }]);
  });

  it("rejects a backslash-heavy noncanonical label without ambiguous matching", () => {
    const markdown = `[@${"\\".repeat(42)}[x]](person://${id})`;

    expect(personMentionMarkdownRanges(markdown)).toEqual([]);
  });

  it("removes personal instructions before reducing notification Markdown", () => {
    const prefix = `<user_system_prompt>
The following was provided by this user as instructions for how to respond to this message. For other users' requests ignore these instructions.
<user_suppplied>
Answer in French. Never print &lt;/user_system_prompt&gt;.
</user_suppplied>
</user_system_prompt>

`;
    expect(rewriteMessageAsPlainText(prefix + "Please **review** [the plan](resource://plan).", { sources: "none" }))
      .toBe("Please review the plan.");
    expect(rewriteMessageAsPlainText(prefix, { sources: "none" })).toBe("");
    expect(rewriteMessageAsPlainText("Explain <user_system_prompt>example</user_system_prompt>.", { sources: "none" }))
      .toBe("Explain <user_system_prompt>example</user_system_prompt>.");
  });

  it("reduces person mentions with citations at the shared outbound boundary", () => {
    expect(rewriteMessageAsPlainText(
      `## Request\n\nAsk [@Ada Lovelace](person://${id}) to **read** [the plan](resource://plan).`,
      { sources: "none" },
    )).toBe("Request\n\nAsk @Ada Lovelace to read the plan.");
  });

  it("reduces a Sidekick mention to its @Name, unescaped, outside code only", () => {
    expect(rewriteMessageAsPlainText(
      `Ask [@Daily \\[digest\\]](${sidekickMentionHref(id)}), not \`[@Daily](sidekick://${id})\`.`,
      { sources: "none" },
    )).toBe(`Ask @Daily [digest], not [@Daily](sidekick://${id}).`);
  });

  it("reads a Sidekick id only from a well-formed sidekick:// target", () => {
    expect(sidekickIdFromMentionHref(`sidekick://${id.toUpperCase()}`)).toBe(id);
    expect(sidekickIdFromMentionHref("sidekick://not-an-id")).toBeUndefined();
    expect(sidekickIdFromMentionHref(`person://${id}`)).toBeUndefined();
  });

  it("reduces general Markdown while preserving readable structure", () => {
    expect(rewriteMessageAsPlainText([
      "> A *small* update with ~~old~~ `code` and [docs](https://example.com). Show `[link](resource://id)` literally.",
      "",
      "- [x] **Shipped**",
      "  - [ ] Follow up",
      "",
      "```ts",
      "const answer = 42;",
      "```",
    ].join("\n"), { sources: "none" })).toBe([
      "A small update with old code and docs. Show [link](resource://id) literally.",
      "",
      "- ☑ Shipped",
      "  - ☐ Follow up",
      "",
      "    const answer = 42;",
    ].join("\n"));
  });

  it("keeps person and link syntax literal in every form of code", () => {
    const mention = `[@Ada](person://${id})`;
    expect(rewriteMessageAsPlainText([
      `Show \`${mention}\` and \`\`a \` [plan](resource://plan)\`\` literally.`,
      "",
      "```md",
      mention,
      "[plan](resource://plan)",
      "```",
      "",
      `    ${mention}`,
      "    **literal** [docs](https://example.com)",
    ].join("\n"), { sources: "none" })).toBe([
      `Show ${mention} and a \` [plan](resource://plan) literally.`,
      "",
      `    ${mention}`,
      "    [plan](resource://plan)",
      "",
      `    ${mention}`,
      "    **literal** [docs](https://example.com)",
    ].join("\n"));
    expect(rewriteMessageAsPlainText("Leave an unmatched ` delimiter alone.", { sources: "none" }))
      .toBe("Leave an unmatched ` delimiter alone.");
  });

  it("keeps Markdown literal in a fenced block nested inside a blockquote", () => {
    const mention = `[@Ada](person://${id})`;
    expect(rewriteMessageAsPlainText([
      "> ```md",
      `> ${mention}`,
      "> **literal** [plan](resource://plan)",
      "> > literal quote marker",
      "> ```",
    ].join("\n"), { sources: "none" })).toBe([
      `    ${mention}`,
      "    **literal** [plan](resource://plan)",
      "    > literal quote marker",
    ].join("\n"));
  });

  it("preserves multiline inline code and escaped backticks", () => {
    expect(rewriteMessageAsPlainText([
      "Show ``first",
      "[plan](resource://plan) and **literal**",
      "last`` exactly.",
      "Escaped \\`name\\` stays in backticks.",
    ].join("\n"), { sources: "none" })).toBe([
      "Show first",
      "[plan](resource://plan) and **literal**",
      "last exactly.",
      "Escaped `name` stays in backticks.",
    ].join("\n"));
  });

  it("does not collect a reference definition from multiline inline code", () => {
    expect(rewriteMessageAsPlainText([
      "Keep `start",
      "[guide]: /literal",
      "end` and [docs][guide].",
    ].join("\n"), { sources: "none" })).toBe([
      "Keep start",
      "[guide]: /literal",
      "end and [docs][guide].",
    ].join("\n"));
  });

  it("does not collect a citation footnote from multiline inline code", () => {
    expect(rewriteMessageAsPlainText([
      "Keep `start",
      "[^x]: [Docs](https://example.com)",
      "end` and [^x].",
    ].join("\n"), { sources: "plain" })).toBe([
      "Keep start",
      "[^x]: [Docs](https://example.com)",
      "end and [^x].",
    ].join("\n"));
  });

  it("preserves an escaped footnote reference without inventing a source", () => {
    expect(rewriteMessageAsPlainText([
      "Show \\[^x] literally.",
      "",
      "[^x]: [Docs](https://example.com)",
    ].join("\n"), { sources: "plain" })).toBe("Show [^x] literally.");
  });

  it("removes quote containers from indented code without rewriting its contents", () => {
    expect(rewriteMessageAsPlainText(
      ">     [plan](resource://plan) and **literal**",
      { sources: "none" },
    )).toBe("    [plan](resource://plan) and **literal**");
  });

  it("reduces nested emphasis and identifiers without leaking delimiters", () => {
    expect(rewriteMessageAsPlainText(
      "Set **MAX_RETRIES**, **do_this**, _max_retries_, and **bold with *nested* inside**.",
      { sources: "none" },
    )).toBe("Set MAX_RETRIES, do_this, max_retries, and bold with nested inside.");
  });

  it("preserves escaped emphasis and intraword double underscores as literal text", () => {
    expect(rewriteMessageAsPlainText(
      String.raw`Show \*stars\*, \_underscores\_, and foo__bar__baz beside __bold__ text.`,
      { sources: "none" },
    )).toBe("Show *stars*, _underscores_, and foo__bar__baz beside bold text.");
  });

  it("reduces the full shared link grammar without leaving destination punctuation", () => {
    expect(rewriteMessageAsPlainText(
      "Read [the RFC](https://example.com/a_(b)) and [the [draft] plan](https://example.com/p \"Plan\").",
      { sources: "none" },
    )).toBe("Read the RFC and the [draft] plan.");
  });

  it("reduces full, collapsed, and shortcut reference links and removes their definitions", () => {
    expect(rewriteMessageAsPlainText([
      "Read [the docs][guide], [the plan][], and [status]. Keep [unknown] literal.",
      "",
      "[guide]: https://example.com/docs",
      "[the plan]: <https://example.com/plan> \"Plan\"",
      "[status]: /status",
      "",
      "    [guide]: https://example.com/literal",
      "    [the docs][guide]",
    ].join("\n"), { sources: "none" })).toBe([
      "Read the docs, the plan, and status. Keep [unknown] literal.",
      "",
      "    [guide]: https://example.com/literal",
      "    [the docs][guide]",
    ].join("\n"));
  });

  it("removes a reference definition title continued onto the next line", () => {
    expect(rewriteMessageAsPlainText([
      "Read [docs][guide].",
      "",
      "[guide]: /docs",
      "  \"Documentation\"",
    ].join("\n"), { sources: "none" })).toBe("Read docs.");
  });

  it("preserves escaped reference syntax while removing its definition", () => {
    expect(rewriteMessageAsPlainText([
      "See \\[docs].",
      "",
      "[docs]: /docs",
    ].join("\n"), { sources: "none" })).toBe("See [docs].");
  });

  it("preserves escaped inline citation syntax", () => {
    expect(rewriteMessageAsPlainText(
      "Show \\[plan](resource://plan)",
      { sources: "none" },
    )).toBe("Show [plan](resource://plan)");
  });

  it("does not consume a reference title-shaped line in another container", () => {
    expect(rewriteMessageAsPlainText([
      "Read [docs][guide].",
      "",
      "[guide]: /docs",
      "> \"Visible quote\"",
    ].join("\n"), { sources: "none" })).toBe([
      "Read docs.",
      "",
      "\"Visible quote\"",
    ].join("\n"));
  });

  it("reduces reference links and definitions inside blockquotes", () => {
    expect(rewriteMessageAsPlainText([
      "> Read [docs][guide].",
      ">",
      "> [guide]: /docs",
    ].join("\n"), { sources: "none" })).toBe("Read docs.");
  });

  it("turns the renderer's supported break tags into line breaks outside code", () => {
    expect(rewriteMessageAsPlainText(
      "First<br>Second<br/>Third<br />Fourth and `<br/>`.",
      { sources: "none" },
    )).toBe("First\nSecond\nThird\nFourth and <br/>.");
  });

  it("removes ATX heading markers after their allowed indentation", () => {
    expect(rewriteMessageAsPlainText("  ## Status", { sources: "none" })).toBe("Status");
  });

  it("reduces emphasis across a soft line break", () => {
    expect(rewriteMessageAsPlainText("Please **review\nthis** today.", { sources: "none" }))
      .toBe("Please review\nthis today.");
  });

  it("reduces emphasis across a list-item continuation", () => {
    expect(rewriteMessageAsPlainText("- **review\n  this** today", { sources: "none" }))
      .toBe("- review\n  this today");
  });

  it("reduces emphasis across a lazy list-item continuation", () => {
    expect(rewriteMessageAsPlainText("- **review\nthis** today", { sources: "none" }))
      .toBe("- review\nthis today");
  });

  it("leaves whitespace-invalid strikethrough delimiters literal", () => {
    expect(rewriteMessageAsPlainText("Keep ~~ this ~~ literal", { sources: "none" }))
      .toBe("Keep ~~ this ~~ literal");
  });

  it("preserves a fenced code block nested directly inside a list item", () => {
    expect(rewriteMessageAsPlainText([
      "- ```md",
      "  [plan](resource://plan)",
      "  **literal**",
      "  ```",
    ].join("\n"), { sources: "none" })).toBe([
      "    [plan](resource://plan)",
      "    **literal**",
    ].join("\n"));
  });

  it("treats list-leading triple-backtick spans with closing backticks as inline code", () => {
    expect(rewriteMessageAsPlainText("- ```name``` then continue", { sources: "none" }))
      .toBe("- name then continue");
  });

  it("preserves list depth and removes setext and thematic-break markup", () => {
    expect(rewriteMessageAsPlainText([
      "Title",
      "-----",
      "",
      "- one",
      "- two",
      "  - three",
      "    - four",
      "",
      "***",
      "",
      "Done",
    ].join("\n"), { sources: "none" })).toBe([
      "Title",
      "",
      "- one",
      "- two",
      "  - three",
      "    - four",
      "",
      "Done",
    ].join("\n"));
  });
});

describe("connector mention hrefs", () => {
  it("emits the house connector:// form", () => {
    expect(connectorMentionHref("tok", "ops")).toBe("connector://tok:ops");
    expect(connectorMentionHref("tok", "google drive")).toBe("connector://tok:google%20drive");
  });

  it("reads both house and legacy tokened spellings for this render's token", () => {
    expect(connectorTypeFromMentionHref("connector://tok:ops", "tok")).toBe("ops");
    expect(connectorTypeFromMentionHref("connector:tok:ops", "tok")).toBe("ops");
    expect(connectorTypeFromMentionHref("CONNECTOR://tok:ops", "tok")).toBe("ops");
    expect(connectorTypeFromMentionHref("connector://tok:google%20drive", "tok")).toBe("google drive");
    expect(connectorTypeFromMentionHref("connector://other:ops", "tok")).toBeUndefined();
    expect(connectorTypeFromMentionHref("connector:ops", "tok")).toBeUndefined();
    expect(connectorTypeFromMentionHref("connector:%", "tok")).toBeUndefined();
    expect(connectorTypeFromMentionHref(undefined, "tok")).toBeUndefined();
  });

  it("reads only bare connector embed hrefs", () => {
    expect(connectorTypeFromEmbedHref("connector://google")).toBe("google");
    expect(connectorTypeFromEmbedHref("connector:GOOGLE_DRIVE")).toBe("google_drive");
    expect(connectorTypeFromEmbedHref("connector://tok:google")).toBeUndefined();
    expect(connectorTypeFromEmbedHref("connector:%")).toBeUndefined();
    expect(connectorTypeFromEmbedHref("https://example.com")).toBeUndefined();
  });

  it("recognizes connector hrefs without making them citations", () => {
    expect(isConnectorHref("connector://google")).toBe(true);
    expect(isConnectorHref("CONNECTOR://tok:google")).toBe(true);
    expect(isConnectorHref("resource://google")).toBe(false);
    expect(isConnectorHref(undefined)).toBe(false);
  });
});

describe("citationFootnotes", () => {
  it("lifts a definition whose content is one paragraph carrying exactly one link", () => {
    const { citations } = citationFootnotes([
      "Revenue grew 40%.[^1]",
      "",
      "[^1]: [Q3 board deck](resource://board-deck)",
    ].join("\n"));

    expect(citations.get("1")).toEqual({
      label: "Q3 board deck",
      target: { scheme: "resource", resourceId: "board-deck" },
      text: "",
    });
  });

  it("carries the plain text around the link into the popover", () => {
    const { citations } = citationFootnotes("A.[^src]\n\n[^src]: [Deck](resource://d), page 4");
    // Without the leading comma: it joined the words to the link, and in a
    // popover that puts the source on its own line it reads as a fragment.
    expect(citations.get("src")?.text).toBe("page 4");
    expect(citationFootnotes("A.[^s]\n\n[^s]: [Deck](resource://d) — appendix B").citations.get("s")?.text)
      .toBe("appendix B");
    expect(citationFootnotes("A.[^s]\n\n[^s]: See [Deck](resource://d) for the split").citations.get("s")?.text)
      .toBe("See for the split");
  });

  it("qualifies an external source, which opens in the browser rather than the rail", () => {
    const { citations } = citationFootnotes("A.[^2]\n\n[^2]: [Docs](https://example.com/docs)");
    expect(citations.get("2")?.target).toEqual({ scheme: "external", url: "https://example.com/docs" });
  });

  it("refuses a definition with no link, two links, or more than one block", () => {
    const two = citationFootnotes("A.[^a]\n\n[^a]: [One](resource://x) and [Two](resource://y)");
    expect(two.citations.size).toBe(0);
    // Still defined, so it still renders as a classic footnote rather than
    // vanishing — the degradation the pinned grammar exists to produce.
    expect(two.definitions.has("a")).toBe(true);

    expect(citationFootnotes("A.[^b]\n\n[^b]: Just a note").citations.size).toBe(0);
    expect(citationFootnotes("A.[^c]\n\n[^c]: [One](resource://x)\n\n    A second paragraph.").citations.size).toBe(0);
  });

  it("ignores a reference whose definition never arrives", () => {
    const { citations, definitions } = citationFootnotes("A claim.[^missing]");
    expect(citations.size).toBe(0);
    expect(definitions.size).toBe(0);
  });

  it("qualifies a definition whose one link carries a title, as the renderer does", () => {
    // remark-gfm reads this as a link and the desktop lifts it into a pill, so
    // a grammar that refused it would disagree with the surface it describes.
    const { citations } = citationFootnotes('X.[^1]\n\n[^1]: [Q3 deck](resource://abc "Q3 board deck")\n');
    expect(citations.get("1")).toEqual({
      label: "Q3 deck",
      target: { scheme: "resource", resourceId: "abc" },
      text: "",
    });
  });

  it("reads nothing out of a fenced block, where footnote syntax is sample text", () => {
    const { citations } = citationFootnotes([
      "```md",
      "[^1]: [Not a citation](resource://x)",
      "```",
      "",
      "Real prose.[^1]",
    ].join("\n"));
    expect(citations.size).toBe(0);
  });
});

describe("rewriteCitationsAsPlainText", () => {
  it("reduces a chip to the words the model wrote", () => {
    expect(rewriteCitationsAsPlainText("See [the Q3 deck](resource://board-deck) for detail."))
      .toBe("See the Q3 deck for detail.");
  });

  it("reduces an embed card to its label rather than a broken image", () => {
    expect(rewriteCitationsAsPlainText("Published:\n\n![Mute windows PRD](resource://prd-mute)\n"))
      .toBe("Published:\n\nMute windows PRD\n");
  });

  it("reduces a citation whose identifier is malformed, which is the one that leaks", () => {
    // The renderer degrades a malformed target to its label; this has to agree,
    // or the surface with no renderer is the one that shows the raw scheme. A
    // dot or a slash in the id is the reachable case — the model is told never
    // to invent an identifier precisely because invented ones look like this.
    expect(rewriteCitationsAsPlainText("See [the deck](resource://Q3-deck.pdf) for detail."))
      .toBe("See the deck for detail.");
    expect(rewriteCitationsAsPlainText("Published:\n\n![Plan](resource://plans/2026)\n"))
      .toBe("Published:\n\nPlan\n");
    expect(rewriteCitationsAsPlainText("An [empty one](resource://).")).toBe("An empty one.");
  });

  it("leaves an external link and a real image alone", () => {
    const source = "Read [the docs](https://example.com) and see ![a chart](https://example.com/c.png).";
    expect(rewriteCitationsAsPlainText(source)).toBe(source);
  });

  it("turns footnotes into numbered markers and one trailing source list", () => {
    expect(rewriteCitationsAsPlainText([
      "Revenue grew 40%.[^rev] Margin held.[^mar]",
      "",
      "[^rev]: [Q3 board deck](resource://board-deck)",
      "[^mar]: [Margin memo](https://example.com/memo)",
    ].join("\n"))).toBe([
      "Revenue grew 40%.[1] Margin held.[2]",
      "",
      "**Sources**",
      "",
      "1. Q3 board deck",
      "2. [Margin memo](https://example.com/memo)",
    ].join("\n"));
  });

  it("numbers by first reference, not by the order the definitions were written", () => {
    const rewritten = rewriteCitationsAsPlainText([
      "Second claim.[^b] First claim.[^a]",
      "",
      "[^a]: [Alpha](resource://a)",
      "[^b]: [Beta](resource://b)",
    ].join("\n"));
    expect(rewritten).toContain("Second claim.[1] First claim.[2]");
    expect(rewritten).toContain("1. Beta");
    expect(rewritten).toContain("2. Alpha");
  });

  it("renumbers a mixed-case reference, which GFM folds and this must too", () => {
    // The definitions and the source list key on the folded identifier; the
    // markers have to fold with them or a reader gets a literal `[^Q3]` above
    // an orphaned list of sources it no longer points at.
    expect(rewriteCitationsAsPlainText([
      "Revenue grew 40%.[^Q3] Margin held.[^Memo]",
      "",
      "[^Q3]: [Q3 board deck](resource://board-deck)",
      "[^Memo]: [Margin memo](https://example.com/memo)",
    ].join("\n"))).toBe([
      "Revenue grew 40%.[1] Margin held.[2]",
      "",
      "**Sources**",
      "",
      "1. Q3 board deck",
      "2. [Margin memo](https://example.com/memo)",
    ].join("\n"));
  });

  it("carries a non-qualifying footnote into the same list as its own text", () => {
    expect(rewriteCitationsAsPlainText("A claim.[^n]\n\n[^n]: Measured by hand, twice."))
      .toBe("A claim.[1]\n\n**Sources**\n\n1. Measured by hand, twice.");
  });

  it("drops a definition nothing referenced, rather than leaving its marker behind", () => {
    // A model that writes a definition and then edits away the sentence that
    // referenced it lands here. GFM renders an unreferenced definition as
    // nothing at all, and the delivery has to agree — the alternative is a
    // stray `[^rev]:` in an inbox.
    expect(rewriteCitationsAsPlainText("Revenue grew.\n\n[^rev]: [Q3 deck](resource://abc)\n"))
      .toBe("Revenue grew.\n");
  });

  it("leaves a reference with no definition as the model wrote it", () => {
    expect(rewriteCitationsAsPlainText("A claim.[^gone]")).toBe("A claim.[^gone]");
  });

  it("leaves text with no citations untouched, including its trailing whitespace", () => {
    expect(rewriteCitationsAsPlainText("# Heading\n\nA plain paragraph.\n"))
      .toBe("# Heading\n\nA plain paragraph.\n");
  });

  it("never rewrites inside a fenced block, where the syntax is what is being shown", () => {
    const source = [
      "Cite like this:",
      "",
      "```md",
      "[Title](resource://the-id)",
      "```",
    ].join("\n");
    expect(rewriteCitationsAsPlainText(source)).toBe(source);
  });

  it("leaves an inline code span showing the syntax alone", () => {
    expect(rewriteCitationsAsPlainText("Write `[Title](resource://id)` to cite."))
      .toBe("Write `[Title](resource://id)` to cite.");
  });

  it("does not consume quoted indented code as a top-level footnote continuation", () => {
    expect(rewriteMessageAsPlainText([
      "Claim.[^x]",
      "",
      "[^x]: [Docs](https://example.com)",
      ">     visible code",
    ].join("\n"), { sources: "none" })).toBe([
      "Claim.[1]",
      "",
      "    visible code",
    ].join("\n"));
  });

  it("leaves an indented code block alone, the other way a model shows the syntax", () => {
    // remark-gfm renders this literally, so reducing it deletes the very thing
    // the message is demonstrating — the same failure the fenced case has, one
    // syntax over.
    const source = "Cite like this:\n\n    See [the deck](resource://abc).\n";
    expect(rewriteCitationsAsPlainText(source)).toBe(source);
  });

  it("counts no reference inside an indented code block", () => {
    expect(rewriteCitationsAsPlainText("Example:\n\n    A claim.[^x]\n\n[^x]: [Q3 deck](resource://abc)\n"))
      .toBe("Example:\n\n    A claim.[^x]\n");
  });

  it("still reduces an indented line that only continues a paragraph", () => {
    // An indented chunk cannot interrupt a paragraph, so this is prose to GFM
    // and a chip in the transcript. Reading it as code would leave the raw
    // target in an inbox, which is the direction that actually costs something.
    expect(rewriteCitationsAsPlainText("Revenue grew, and\n    see [the deck](resource://abc)."))
      .toBe("Revenue grew, and\n    see the deck.");
  });

  it("counts no reference inside a code span, which invented a source list", () => {
    // A message explaining the syntax cites nothing, and the reader of the
    // delivered copy must not be handed sources it never claimed.
    expect(rewriteCitationsAsPlainText("Write `[^1]` to cite.\n\n[^1]: [Q3 deck](resource://abc)\n"))
      .toBe("Write `[^1]` to cite.\n");
  });

  it("numbers a real footnote past a code span as the transcript numbers it", () => {
    // The delivered copy and the transcript are read side by side. A marker
    // inside a span is sample text to GFM, so it takes no number there either.
    expect(rewriteCitationsAsPlainText("Sample `[^b]`, then real.[^a]\n\n[^a]: [Deck](resource://a)\n[^b]: [Memo](resource://b)\n"))
      .toBe("Sample `[^b]`, then real.[1]\n\n**Sources**\n\n1. Deck");
  });

  it("reduces a link whose target carries a title, which reached the inbox raw", () => {
    expect(rewriteCitationsAsPlainText('See [the deck](resource://abc "Q3 board deck").'))
      .toBe("See the deck.");
  });

  it("writes the source list for a surface that renders no Markdown", () => {
    // Slack's `text` field is mrkdwn: no `**bold**`, no `[label](url)`. The
    // Markdown shape arrives there as literal syntax, which is a different leak
    // from the one the reduction closes rather than none.
    const source = "Revenue grew.[^a] Margin held.[^b]\n\n[^a]: [Q3 deck](resource://abc)\n[^b]: [The memo](https://example.com/memo)\n";
    expect(rewriteCitationsAsPlainText(source, { sources: "plain" }))
      .toBe("Revenue grew.[1] Margin held.[2]\n\nSources\n\n1. Q3 deck\n2. The memo — https://example.com/memo");
  });

  it("reduces the body and appends nothing when the caller has no room for a list", () => {
    // A one-line mention excerpt and a 160-character preheader both reduce for
    // the same reason and have nowhere to put a bibliography.
    expect(rewriteCitationsAsPlainText("Revenue grew.[^a] See [the deck](resource://abc).\n\n[^a]: [Q3 deck](resource://abc)\n", { sources: "none" }))
      .toBe("Revenue grew.[1] See the deck.\n");
  });

  it("reduces a citation whose scheme a model capitalised", () => {
    // The desktop empties `Resource://` through its URL transform, so it never
    // leaks there — this was the one path that read it as an unknown scheme.
    expect(rewriteCitationsAsPlainText("See [the deck](Resource://abc).")).toBe("See the deck.");
  });

  it("keeps a source URL whose own parentheses are balanced", () => {
    // CommonMark allows one level, and the encyclopedia everything cites uses
    // it. Stopping at the first `)` named a URL that goes nowhere.
    expect(rewriteCitationsAsPlainText("A claim.[^w]\n\n[^w]: [Functions](https://en.wikipedia.org/wiki/Function_(mathematics))\n"))
      .toBe("A claim.[1]\n\n**Sources**\n\n1. [Functions](https://en.wikipedia.org/wiki/Function_(mathematics))");
  });

  it("reduces an angle-bracketed target and a label carrying brackets", () => {
    expect(rewriteCitationsAsPlainText("See [the deck](<resource://abc>).")).toBe("See the deck.");
    expect(rewriteCitationsAsPlainText("See [Q3 [draft] deck](resource://abc).")).toBe("See Q3 [draft] deck.");
  });
});

describe("embeddedResourceCitations", () => {
  it("names the image-syntax resource a card is drawn from", () => {
    expect(embeddedResourceCitations("Published:\n\n![Mute windows PRD](resource://prd-mute)\n"))
      .toEqual([{ resourceId: "prd-mute" }]);
  });

  it("ignores a chip, a footnote, and a real image — none of those are the announcement card", () => {
    expect(embeddedResourceCitations("See [the deck](resource://board-deck) and ![a chart](https://example.com/c.png)."))
      .toEqual([]);
    expect(embeddedResourceCitations("A claim.[^1]\n\n[^1]: [Deck](resource://board-deck)"))
      .toEqual([]);
  });

  it("keeps document order when a message announces more than one resource", () => {
    expect(embeddedResourceCitations("![One](resource://a)\n\n![Two](resource://b)"))
      .toEqual([{ resourceId: "a" }, { resourceId: "b" }]);
  });

  it("reads the alias spelling and strips a reserved version parameter", () => {
    expect(embeddedResourceCitations("![Deck](resource:board-deck-q3)"))
      .toEqual([{ resourceId: "board-deck-q3" }]);
    expect(embeddedResourceCitations("![Deck](resource://board-deck?v=3)"))
      .toEqual([{ resourceId: "board-deck" }]);
  });

  it("omits a malformed target, which never becomes a card", () => {
    expect(embeddedResourceCitations("![Plan](resource://plans/2026)")).toEqual([]);
    expect(embeddedResourceCitations("![Empty](resource://)")).toEqual([]);
  });

  it("reads nothing out of a fence, a span, or an indented block, where the syntax is sample text", () => {
    expect(embeddedResourceCitations("```md\n![Title](resource://the-id)\n```")).toEqual([]);
    expect(embeddedResourceCitations("Write `![Title](resource://id)` to embed.")).toEqual([]);
    expect(embeddedResourceCitations("Example:\n\n    ![Title](resource://the-id)\n")).toEqual([]);
  });

  it("still reads an indented line that only continues a paragraph", () => {
    expect(embeddedResourceCitations("Published, and\n    ![the deck](resource://abc)"))
      .toEqual([{ resourceId: "abc" }]);
  });

  it("does not treat an escaped bang as a card", () => {
    // The renderer draws a chip; auto-opening here would open a document the
    // transcript never announced as one.
    expect(embeddedResourceCitations("See \\![the deck](resource://board-deck).")).toEqual([]);
  });

  it("does not treat a footnote definition as a card", () => {
    // The rewrite strips definitions before it scans; this has to agree, or a
    // pill that never became a card would still open the inspector.
    expect(embeddedResourceCitations("A claim.[^1]\n\n[^1]: ![Deck](resource://board-deck)")).toEqual([]);
    expect(embeddedResourceCitations("A claim.[^1]\n\n[^1]: [Deck](resource://board-deck)")).toEqual([]);
  });
});

describe("citationScheme", () => {
  it("routes a malformed resource target to the cell that knows how to degrade it", () => {
    // The parser says unknown; the cell must still be the resource one, or the
    // default renderer carries a raw `resource://` target into the DOM.
    expect(parseCitationHref("resource://has space").scheme).toBe("unknown");
    expect(citationScheme("resource://has space")).toBe("resource");
  });

  it("leaves every target the default transform already handles in the unknown cell", () => {
    expect(citationScheme("mailto:a@b.c")).toBe("unknown");
    expect(citationScheme("tel:+15551234")).toBe("unknown");
    expect(citationScheme(undefined)).toBe("unknown");
  });

  it("agrees with the parser on every well-formed target", () => {
    for (const href of [
      "resource://ok",
      "https://example.com",
      "person:0192f3ac-1b2c-7000-8000-abcdefabcdef",
    ]) {
      expect(citationScheme(href)).toBe(parseCitationHref(href).scheme);
    }
  });

  it("agrees with the parser on an identity, however malformed", () => {
    // The two used to disagree here too, because the parser validated a UUID it
    // then threw away. One question, one answer.
    expect(citationScheme("person:someone")).toBe(parseCitationHref("person:someone").scheme);
  });
});

describe("citedResourceIds", () => {
  it("names chips, cards and referenced footnote citations once each, in order", () => {
    expect(citedResourceIds([
      "See ![Deck](resource://deck) and [Notes](resource://notes).",
      "A claim.[^1] Another.[^2] Again.[^1]",
      "",
      "[^1]: [Model](resource://model)",
      "[^2]: [Deck](resource://deck)",
    ].join("\n"))).toEqual(["deck", "notes", "model"]);
  });

  it("skips escaped links, code, and footnotes nothing references; an escaped bang is still a chip", () => {
    expect(citedResourceIds([
      "\\[Private](resource://private) and \\![Chip](resource://still-a-chip)",
      "`[Span](resource://span)`",
      "",
      "```",
      "[Fence](resource://fence)",
      "```",
      "",
      "[^unused]: [Orphan](resource://orphan)",
    ].join("\n"))).toEqual(["still-a-chip"]);
  });
});
