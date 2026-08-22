import { describe, expect, it } from "vitest";
import {
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
