import { describe, expect, it } from "vitest";

import { __slackAgentTesting } from "../src/services/slack-agent-service";

const { splitSlackText } = __slackAgentTesting;

describe("splitting a Slack answer", () => {
  it("leaves an answer inside the limit as one message", () => {
    expect(splitSlackText("A short result.")).toEqual(["A short result."]);
  });

  it("says something rather than nothing when there is no text at all", () => {
    expect(splitSlackText("")).toEqual(["Avalon completed the task without a text response."]);
  });

  it("cuts at a paragraph break rather than mid-sentence", () => {
    const first = `${"a".repeat(5_000)}\n\n${"b".repeat(5_000)}`;
    const chunks = splitSlackText(`${first}\n\n${"c".repeat(5_000)}`);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(first);
    expect(chunks[1]).toBe("c".repeat(5_000));
  });

  it("falls back to a line break, then a space, before cutting a word", () => {
    const lines = Array.from({ length: 400 }, (_unused, index) => `line ${index} ${"x".repeat(40)}`).join("\n");
    for (const chunk of splitSlackText(lines)) expect(chunk.endsWith("x")).toBe(true);

    const words = Array.from({ length: 3_000 }, () => "word").join(" ");
    for (const chunk of splitSlackText(words)) expect(chunk.endsWith("word")).toBe(true);
  });

  it("cuts an unbroken run rather than exceeding the limit", () => {
    const chunks = splitSlackText("z".repeat(30_000));

    expect(chunks).toHaveLength(3);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(12_000);
  });

  it("never hands Slack more than it accepts", () => {
    const source = Array.from({ length: 900 }, (_unused, index) => `## Section ${index}\n\n${"detail ".repeat(40)}`).join("\n\n");
    const chunks = splitSlackText(source);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(12_000);
  });

  it("closes a code block it had to cut, and reopens it in the next message", () => {
    // Without this the first message ends in half a block and the second
    // renders its entire contents, prose included, as code.
    const chunks = splitSlackText(`Intro\n\n\`\`\`ts\n${"const value = 1;\n".repeat(900)}\`\`\`\n\nDone`);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.endsWith("```")).toBe(true);
    expect(chunks[1]!.startsWith("```\n")).toBe(true);
    // Every message opens and closes an even number of fences, which is what
    // makes each one render on its own.
    for (const chunk of chunks) {
      expect(chunk.split("\n").filter((line) => /^[ \t]*(?:```|~~~)/u.test(line)).length % 2).toBe(0);
    }
  });

  it("loses none of the answer across the cuts", () => {
    const source = Array.from({ length: 2_000 }, (_unused, index) => `Point ${index}.`).join(" ");

    expect(splitSlackText(source).join(" ")).toBe(source);
  });
});
