import { describe, expect, it } from "vitest";
import { z } from "zod";

import { harnessErrorFrames } from "../src/durable-objects/agent-loop-do";

/**
 * What `workstream_harness_threw` records about *where* a run died.
 *
 * This existed as `stack.split("\n").slice(0, 6)`, which is right for an
 * ordinary one-line message and wrong for the errors that actually reach it. A
 * `ZodError`'s message is multi-line JSON, so the six lines captured were six
 * lines of the message and no frames at all — and `reason` already carries the
 * message. Production spent days unable to tell which of four call sites a
 * validation failure came from, on a log written specifically to answer that.
 */
describe("harnessErrorFrames", () => {
  it("keeps frames from an error whose message spans many lines", () => {
    // Thrown rather than `safeParse`d, because that is how production reaches
    // this: a `.parse()` inside run setup. Node fills the stack on the throw,
    // and for this error it is twelve lines of message followed by five frames
    // — so taking the first six lines took no frames at all.
    let thrown: unknown;
    try {
      z.strictObject({ query: z.string().max(3) }).parse({ query: "far too long" });
    } catch (error) {
      thrown = error;
    }

    const frames = harnessErrorFrames(thrown);

    // The message is what the old slice captured and `reason` already carries;
    // its absence is the whole change. The dropped third assertion — that every
    // line starts with `at ` — restated the implementation's own filter and
    // could not fail.
    expect(frames).not.toBeNull();
    expect(frames).not.toContain("too_big");
    expect(frames).toContain("at ");
  });

  it("returns null rather than a message when an error carries no frames", () => {
    const bare = new Error("no frames here");
    bare.stack = "Error: no frames here";

    expect(harnessErrorFrames(bare)).toBeNull();
    expect(harnessErrorFrames("not an error")).toBeNull();
  });
});
