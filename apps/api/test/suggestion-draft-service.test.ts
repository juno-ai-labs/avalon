import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { parseDraft, withEveryEmbed } from "../src/services/suggestion-draft-service";

describe("parseDraft", () => {
  it("keeps every embed of the judged message in a merge note, appending the ones the drafter did not carry", () => {
    const judged = "Done. See [Price model](resource://res-1) and the [Rollout plan](resource://res-2).";
    const note = parseDraft("merge_up", { text: "Pricing is final; the model is in [Price model](resource://res-1)." }, judged);
    expect(note).toEqual({
      text: "Pricing is final; the model is in [Price model](resource://res-1).\n\n[Rollout plan](resource://res-2)",
      subject: null,
    });
    expect(withEveryEmbed("No links here.", "Nothing embedded either.")).toBe("No links here.");
  });

  it("refuses empty words and a missing subject with the field named", () => {
    expect(() => parseDraft("merge_up", { text: "   " }, "")).toThrow(ZodError);
    try {
      parseDraft("start_breakout", { prompt: "Decide the Starter tier." }, "");
      throw new Error("accepted a prompt without a subject");
    } catch (error) {
      expect(error).toBeInstanceOf(ZodError);
      expect((error as ZodError).issues.map((issue) => issue.path.join("."))).toEqual(["subject"]);
    }
  });

  it("cuts a long subject to the chip's budget by code point", () => {
    const draft = parseDraft("start_breakout", { prompt: "Decide the Starter tier.", subject: "é".repeat(200) }, "");
    expect(draft.subject).toHaveLength(120);
  });
});
