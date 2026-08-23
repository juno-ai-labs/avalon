import { describe, expect, it } from "vitest";
import {
  resolveSlackReactions,
  slackDefaultReactionFor,
  slackWorkingReaction,
  SLACK_DEFAULT_REACTIONS,
} from "./slack-reactions";

describe("resolving a Slack reaction set", () => {
  it("uses Avalon's own vocabulary when nothing is configured", () => {
    expect(resolveSlackReactions()).toEqual(SLACK_DEFAULT_REACTIONS);
    expect(resolveSlackReactions(null, undefined)).toEqual(SLACK_DEFAULT_REACTIONS);
  });

  it("inherits every state an override does not name", () => {
    const resolved = resolveSlackReactions({ outcomes: { completed: "tada" } });
    expect(resolved.outcomes.completed).toBe("tada");
    expect(resolved.outcomes.failed).toBe(SLACK_DEFAULT_REACTIONS.outcomes.failed);
    expect(resolved.acknowledgement).toBe(SLACK_DEFAULT_REACTIONS.acknowledgement);
    expect(resolved.working).toEqual(SLACK_DEFAULT_REACTIONS.working);
  });

  it("lets a later override beat an earlier one, state by state", () => {
    const resolved = resolveSlackReactions(
      { acknowledgement: "wave", working: ["hourglass"] },
      { acknowledgement: "salute" },
    );
    expect(resolved.acknowledgement).toBe("salute");
    // The workspace tier named the rotation and the run tier did not, so it holds.
    expect(resolved.working).toEqual(["hourglass"]);
  });

  it("ignores a malformed override rather than failing a member's run", () => {
    expect(resolveSlackReactions({ acknowledgement: "not a valid name!" })).toEqual(SLACK_DEFAULT_REACTIONS);
    expect(resolveSlackReactions({ unknownKey: "x" })).toEqual(SLACK_DEFAULT_REACTIONS);
    expect(resolveSlackReactions("nonsense", 42, [])).toEqual(SLACK_DEFAULT_REACTIONS);
  });

  it("keeps a valid override when a later one is malformed", () => {
    const resolved = resolveSlackReactions({ acknowledgement: "wave" }, { working: [] });
    expect(resolved.acknowledgement).toBe("wave");
  });

  it("refuses a rotation interval below Slack's rate-limit floor", () => {
    // Faster than this and a handful of concurrent runs exhaust `reactions.add`.
    expect(resolveSlackReactions({ workingIntervalMs: 500 }).workingIntervalMs)
      .toBe(SLACK_DEFAULT_REACTIONS.workingIntervalMs);
    expect(resolveSlackReactions({ workingIntervalMs: 10_000 }).workingIntervalMs).toBe(10_000);
  });
});

describe("the working rotation", () => {
  it("wraps rather than running out", () => {
    const set = resolveSlackReactions({ working: ["a", "b", "c"] });
    expect([0, 1, 2, 3, 4].map((cursor) => slackWorkingReaction(set, cursor))).toEqual(["a", "b", "c", "a", "b"]);
  });

  it("starts on the first reaction the rotation declares", () => {
    // A run is admitted with the cursor at 0, so cursor 0 has to be the first
    // documented emoji. Pre-incrementing before the lookup skipped it: the first
    // tick showed the second entry and most runs ended before it wrapped.
    expect(slackWorkingReaction(SLACK_DEFAULT_REACTIONS, 0)).toBe(SLACK_DEFAULT_REACTIONS.working[0]);
    expect(slackWorkingReaction(SLACK_DEFAULT_REACTIONS, 0)).toBe("brain");
  });

  it("survives a cursor that went backwards", () => {
    expect(slackWorkingReaction(resolveSlackReactions({ working: ["a", "b"] }), -1)).toBe("b");
  });

  it("draws its fallback from Avalon's defaults, not the configured set", () => {
    // The fallback exists for an emoji Slack refused, so it cannot come from the
    // same configuration that produced the refused name.
    expect(slackDefaultReactionFor("working", 0)).toBe(SLACK_DEFAULT_REACTIONS.working[0]);
    expect(slackDefaultReactionFor("acknowledgement")).toBe("eyes");
    expect(slackDefaultReactionFor("failed")).toBe("warning");
  });
});
