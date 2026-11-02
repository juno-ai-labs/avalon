import { describe, expect, it } from "vitest";
import {
  slackDeliveryMarkdown,
  slackMarkdownMessages,
  slackNotificationText,
  splitSlackMarkdown,
  SLACK_MARKDOWN_BLOCK_LIMIT,
} from "./slack-markdown";

describe("Slack markdown rendering", () => {
  it("renders agent markdown as a markdown block rather than mrkdwn text", () => {
    const [message] = slackMarkdownMessages("### Outcome\n\n- **File:** report.txt");
    expect(message?.blocks).toEqual([{ type: "markdown", text: "### Outcome\n\n- **File:** report.txt" }]);
  });

  it("keeps the heading out of the notification fallback, where it cannot render", () => {
    const [message] = slackMarkdownMessages("### Outcome\n\n- **File:** report.txt");
    // The fallback is read aloud and shown in a push banner, so the syntax that
    // the block renders is stripped rather than repeated as literal characters.
    expect(message?.text).toBe("Outcome\n\n• File: report.txt");
  });

  it("titles the first message only, so a long result is not re-headed per chunk", () => {
    const messages = slackMarkdownMessages(`${"paragraph\n\n".repeat(2_000)}end`, { header: "SAFE review" });
    expect(messages.length).toBeGreaterThan(1);
    expect(messages[0]?.blocks[0]).toEqual({ type: "header", text: { type: "plain_text", text: "SAFE review" } });
    expect(messages.slice(1).every((message) => message.blocks[0]?.type === "markdown")).toBe(true);
  });

  it("falls back rather than posting an empty message Slack would reject", () => {
    const [message] = slackMarkdownMessages("   \n  ", { fallback: "Avalon completed the task." });
    expect(message?.text).toBe("Avalon completed the task.");
    expect(slackMarkdownMessages("   ")).toEqual([]);
  });

  it("never emits a message whose fallback text is empty", () => {
    // Slack's `text` field is `min(1)`; a body of pure syntax must not strip to "".
    const [message] = slackMarkdownMessages("```\n```");
    expect(message?.text.length).toBeGreaterThan(0);
  });
});

describe("splitting Slack markdown", () => {
  it("leaves text that already fits as one chunk", () => {
    expect(splitSlackMarkdown("# Title\n\nBody")).toEqual(["# Title\n\nBody"]);
  });

  it("breaks at a paragraph seam rather than mid-sentence", () => {
    const paragraph = `${"word ".repeat(100).trim()}\n\n`;
    const chunks = splitSlackMarkdown(paragraph.repeat(40), 2_000);
    expect(chunks.length).toBeGreaterThan(1);
    // A seam break means no chunk starts or ends inside a word.
    for (const chunk of chunks) expect(chunk.trim().endsWith("word")).toBe(true);
  });

  it("closes and reopens a fence rather than severing a code block", () => {
    const code = `\`\`\`ts\n${"const value = 1;\n".repeat(400)}\`\`\``;
    const chunks = splitSlackMarkdown(code, 2_000);
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk is independently valid: an even number of fence lines each.
    for (const chunk of chunks) {
      expect(chunk.split("\n").filter((line) => line.startsWith("```")).length % 2).toBe(0);
    }
    expect(chunks[1]?.startsWith("```ts")).toBe(true);
  });

  it("does not treat a blank line inside a fence as a paragraph seam", () => {
    const code = `\`\`\`\n${"line\n\n".repeat(400)}\`\`\``;
    for (const chunk of splitSlackMarkdown(code, 2_000)) {
      expect(chunk.startsWith("```")).toBe(true);
      expect(chunk.endsWith("```")).toBe(true);
    }
  });

  it("repeats a table's header on each chunk the table continues into", () => {
    // Each chunk is its own markdown block, and rows without a header and
    // delimiter row render as pipe-delimited prose, not as a table.
    const header = "| Metric | Value |\n|---|---:|";
    const rows = Array.from({ length: 120 }, (_, index) => `| row ${index} | ${index} |`);
    const prose = "Closing words that run long enough to need a chunk of their own.\n".repeat(30);
    const chunks = splitSlackMarkdown(`Intro.\n\n${header}\n${rows.join("\n")}\n\n${prose}`, 1_000);
    const tableChunks = chunks.filter((chunk) => chunk.includes("| row "));
    expect(tableChunks.length).toBeGreaterThan(1);
    for (const chunk of tableChunks) {
      expect(chunk.length).toBeLessThanOrEqual(1_000);
      expect(chunk.slice(chunk.indexOf("| Metric")).startsWith(header)).toBe(true);
    }
    // Every row arrives exactly once; only the header repeats.
    const delivered = chunks.join("\n").split("\n").filter((line) => line.startsWith("| row "));
    expect(delivered).toEqual(rows);
    // Prose after the table is not a table row and is not given a header.
    expect(chunks.at(-1)?.startsWith("Closing words")).toBe(true);
  });

  it("moves a header row onto the chunk that holds its delimiter", () => {
    const lead = "x".repeat(82);
    const chunks = splitSlackMarkdown(`${lead}\n| A | B |\n|---|---|\n| 1 | 2 |`, 100);
    expect(chunks).toEqual([lead, "| A | B |\n|---|---|\n| 1 | 2 |"]);
  });

  it("hard-breaks only a single line longer than the whole budget", () => {
    const chunks = splitSlackMarkdown("x".repeat(5_000), 1_000);
    expect(chunks.length).toBe(5);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(1_000);
  });

  it("keeps every chunk inside Slack's markdown block limit", () => {
    const chunks = splitSlackMarkdown(`${"sentence. ".repeat(40)}\n\n`.repeat(200));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(SLACK_MARKDOWN_BLOCK_LIMIT);
  });

  it("keeps every chunk inside the limit even when a fence is open", () => {
    // The regression: a single line longer than the budget with a fence open —
    // minified JSON, a base64 payload, a long log line. The budget was computed
    // once per source line, so pieces after a mid-line flush were still measured
    // against the overhead of no carried fence and came back over the limit with
    // a reopened fence on top.
    const source = `Here is the payload:\n\n\`\`\`json\n${"a".repeat(30_000)}\n\`\`\`\n`;
    for (const chunk of splitSlackMarkdown(source)) {
      expect(chunk.length).toBeLessThanOrEqual(SLACK_MARKDOWN_BLOCK_LIMIT);
    }
  });

  it("holds the limit across fenced and unfenced shapes alike", () => {
    // A property check over the two rules together: the fence-balance test used
    // short lines and the length test used fence-free prose, so neither covered
    // a chunk that has to carry a reopened fence *and* a full body.
    const shapes = [
      `\`\`\`\n${"x".repeat(40_000)}\n\`\`\``,
      `${"word ".repeat(50)}\n\n\`\`\`ts\n${"const a = 1;\n".repeat(2_000)}\`\`\`\n\n${"tail ".repeat(50)}`,
      `\`\`\`\n${"y".repeat(11_990)}\n\`\`\`\n\n${"z".repeat(11_990)}`,
      `# Title\n\n${"para\n\n".repeat(3_000)}`,
    ];
    for (const shape of shapes) {
      const chunks = splitSlackMarkdown(shape);
      for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(SLACK_MARKDOWN_BLOCK_LIMIT);
      for (const chunk of chunks) {
        expect(chunk.split("\n").filter((line) => line.startsWith("```")).length % 2).toBe(0);
      }
    }
  });

  it("drops nothing: the chunks still carry the whole body", () => {
    const source = `${"paragraph body here\n\n".repeat(500)}tail`;
    const rejoined = splitSlackMarkdown(source, 1_500).join("\n").replace(/\n+/gu, " ");
    expect(rejoined).toContain("tail");
    expect(rejoined.match(/paragraph body here/gu)?.length).toBe(500);
  });
});

describe("Slack notification fallback", () => {
  it("strips the syntax a notification banner cannot render", () => {
    expect(slackNotificationText("## Title\n\n> quoted\n\n1. first\n\n`code`\n\n[link](https://example.com)"))
      .toBe("Title\n\nquoted\n\n• first\n\ncode\n\nlink");
  });

  it("truncates rather than sending a wall of text to a phone", () => {
    const text = slackNotificationText("word ".repeat(4_000), 100);
    expect(text.length).toBe(100);
    expect(text.endsWith("…")).toBe(true);
  });
});

/**
 * Citations leaving Rally for a channel.
 *
 * Slack renders neither the `resource://` scheme nor footnote syntax, so an
 * unrewritten citation lands verbatim in front of everybody in the channel.
 * The transcript copy of the same answer keeps its citations — only what goes
 * out is rewritten.
 */
describe("citations in a Slack delivery", () => {
  it("reduces chips and embeds to the words the model wrote", () => {
    const [message] = slackMarkdownMessages(
      "Published:\n\n![Mute windows PRD](resource://prd-mute)\n\nSee [the deck](resource://board-deck).",
    );

    const text = JSON.stringify(message?.blocks);
    expect(text).not.toContain("resource:");
    expect(text).toContain("Mute windows PRD");
    expect(text).toContain("See the deck.");
  });

  it("turns footnotes into numbered markers over one plain source list", () => {
    const [message] = slackMarkdownMessages([
      "Revenue grew 40%.[^rev] Margin held.[^mar]",
      "",
      "[^rev]: [Q3 board deck](resource://board-deck)",
      "[^mar]: [Margin memo](https://example.com/memo)",
    ].join("\n"));

    const block = (message?.blocks.at(-1) as { text: string }).text;
    expect(block).toContain("Revenue grew 40%.[1] Margin held.[2]");
    expect(block).toContain("**Sources**");
    expect(block).toContain("1. Q3 board deck");
    expect(block).toContain("2. [Margin memo](https://example.com/memo)");
    expect(block).not.toContain("[^");
  });

  it("keeps the raw syntax out of the notification fallback too", () => {
    const [message] = slackMarkdownMessages("See [the deck](resource://board-deck).");

    expect(message?.text).toBe("See the deck.");
  });

  it("is idempotent, so a path that reduces twice is not a path that double-renumbers", () => {
    // The streaming path reduces its own text and the batched path reduces
    // inside `slackMarkdownMessages`; a delivery that grew a second call would
    // otherwise renumber `[1]` into `[1]` of a list it had already emitted.
    const once = slackDeliveryMarkdown("A.[^a] See [the deck](resource://d).\n\n[^a]: [Deck](resource://d)");

    // Pinned against the literal first: comparing the subject's output to its
    // own output is satisfied by a no-op, so the identity function would pass
    // an idempotence check that asserted only the second half of this.
    expect(once).toBe("A.[1] See the deck.\n\n**Sources**\n\n1. Deck");
    expect(slackDeliveryMarkdown(once)).toBe(once);
  });

  it("leaves ordinary markdown, external links included, exactly as it was", () => {
    const source = "### Outcome\n\nRead [the docs](https://example.com/docs).";
    const [message] = slackMarkdownMessages(source);

    expect((message?.blocks.at(-1) as { text: string }).text).toBe(source);
  });

  it("rewrites before chunking, so a source list cannot be severed from its markers", () => {
    // Rewriting after the split would run the footnote pass over a chunk whose
    // definitions landed in the next one, and renumber against a body it could
    // not see.
    const long = `${"paragraph\n\n".repeat(2_000)}Final claim.[^a]\n\n[^a]: [Deck](resource://d)`;
    const messages = slackMarkdownMessages(long);

    const all = messages.map((message) => (message.blocks.at(-1) as { text: string }).text).join("\n");
    expect(all).toContain("Final claim.[1]");
    expect(all).toContain("1. Deck");
    expect(all).not.toContain("resource:");
  });
});
