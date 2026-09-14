import { describe, expect, it } from "vitest";
import {
  resolveSlackReactions,
  slackDefaultReactionFor,
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
  });

  it("lets a later override beat an earlier one, state by state", () => {
    const resolved = resolveSlackReactions(
      { acknowledgement: "wave", outcomes: { failed: "rotating_light" } },
      { acknowledgement: "salute" },
    );
    expect(resolved.acknowledgement).toBe("salute");
    // The workspace tier named the failure emoji and the run tier did not.
    expect(resolved.outcomes.failed).toBe("rotating_light");
  });

  it("ignores a malformed override rather than failing a member's run", () => {
    expect(resolveSlackReactions({ acknowledgement: "not a valid name!" })).toEqual(SLACK_DEFAULT_REACTIONS);
    expect(resolveSlackReactions({ unknownKey: "x" })).toEqual(SLACK_DEFAULT_REACTIONS);
    expect(resolveSlackReactions("nonsense", 42, [])).toEqual(SLACK_DEFAULT_REACTIONS);
  });

  it("keeps a valid override when a later one is malformed", () => {
    const resolved = resolveSlackReactions({ acknowledgement: "wave" }, { outcomes: { completed: "" } });
    expect(resolved.acknowledgement).toBe("wave");
    expect(resolved.outcomes.completed).toBe(SLACK_DEFAULT_REACTIONS.outcomes.completed);
  });

  it("refuses the rotation an older configuration could name", () => {
    // `working` and `workingIntervalMs` were the rotation's configuration. The
    // schema is strict, so an installation still carrying them resolves to the
    // defaults rather than half-applying a set built for a state that is gone.
    expect(resolveSlackReactions({ acknowledgement: "wave", working: ["brain"] }))
      .toEqual(SLACK_DEFAULT_REACTIONS);
    expect(resolveSlackReactions({ workingIntervalMs: 6_000 })).toEqual(SLACK_DEFAULT_REACTIONS);
  });
});

describe("the fallback vocabulary", () => {
  it("draws its fallback from Avalon's defaults, not the configured set", () => {
    // The fallback exists for an emoji Slack refused, so it cannot come from the
    // same configuration that produced the refused name.
    expect(slackDefaultReactionFor("acknowledgement")).toBe("eyes");
    expect(slackDefaultReactionFor("completed")).toBe("white_check_mark");
    expect(slackDefaultReactionFor("failed")).toBe("x");
  });
});
