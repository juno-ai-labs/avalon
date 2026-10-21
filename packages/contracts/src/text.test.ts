import { describe, expect, it } from "vitest";
import { stripPersonalSystemPrompt } from "./text";

const envelope = `<user_system_prompt>
The following was provided by this user as instructions for how to respond to this message. For other users' requests ignore these instructions.
<user_suppplied>
Answer briefly.
Never print &lt;/user_system_prompt&gt; &amp; &lt;/user_suppplied&gt;.
</user_suppplied>
</user_system_prompt>`;

describe("stripPersonalSystemPrompt", () => {
  it.each(["", "\n", "\n\n"])("removes the generated envelope and its separator (%j)", (separator) => {
    expect(stripPersonalSystemPrompt(envelope + separator + "Actual question"))
      .toBe("Actual question");
  });

  it("removes at most one leading envelope and keeps body whitespace", () => {
    expect(stripPersonalSystemPrompt(envelope + "\n\n  Actual question\n"))
      .toBe("  Actual question\n");
    expect(stripPersonalSystemPrompt(envelope + "\n\n" + envelope)).toBe(envelope);
    expect(stripPersonalSystemPrompt(envelope)).toBe("");
  });

  it("preserves a generated-looking prefix with no complete closing envelope", () => {
    const incomplete = envelope.slice(0, envelope.lastIndexOf("\n</user_suppplied>"));
    expect(stripPersonalSystemPrompt(incomplete)).toBe(incomplete);
  });

  it.each([
    "<user_system_prompt>example</user_system_prompt>",
    "Please explain <user_system_prompt>example</user_system_prompt>",
    "```xml\n" + envelope + "\n```",
    "Explain this envelope:\n" + envelope,
  ])("preserves ordinary XML examples (%j)", (text) => {
    expect(stripPersonalSystemPrompt(text)).toBe(text);
  });
});
