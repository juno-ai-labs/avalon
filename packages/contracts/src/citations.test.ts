import { describe, expect, it } from "vitest";
import {
  citationFootnotes,
  citationScheme,
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
