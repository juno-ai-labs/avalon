import { describe, expect, it } from "vitest";
import { emailMentionAddresses } from "./email-mentions";

describe("emailMentionAddresses", () => {
  it("reads each address whole, lower case, once, with sentence punctuation after it", () => {
    expect(emailMentionAddresses("Hey @Dana@Example.com, and @dana@example.com.au. Also @dana@example.com."))
      .toEqual(["dana@example.com", "dana@example.com.au"]);
  });

  it("reads a mention inside formatting", () => {
    expect(emailMentionAddresses("**@dana@example.com** please")).toEqual(["dana@example.com"]);
  });

  it("ignores code, explicit links and an address with no @ before it", () => {
    expect(emailMentionAddresses([
      "`@dana@example.com`",
      "```\n@eli@example.com\n```",
      "@[fay@example.com](mailto:fay@example.com)",
      "write to gus@example.com",
    ].join("\n\n"))).toEqual([]);
  });
});
