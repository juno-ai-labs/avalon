import { describe, expect, it } from "vitest";

import {
  DemoPackSchema,
  PLACEHOLDER_DEMO_PACK,
  packCanvasFacts,
  planDemoSeed,
  visibleCanvasesFor,
  visibleSidekicksFor,
  packSidekickFacts,
  type DemoCast,
} from "../src/services/demo-pack";

/**
 * A pack is playable or it is refused before the first write.
 *
 * The rules here are the ones a bad pack would otherwise break against the
 * production path several actions in: a Canvas used before it exists, a line
 * from somebody the Canvas does not admit, a publish with no run of Rally's
 * to attribute it to, a Canvas that carries on after its question. Each is a
 * parse-time refusal so the operator sees it as "bad pack" rather than as a
 * half-seeded workspace.
 */

const CAST: DemoCast = {
  presenter: { userId: "00000000-0000-7000-8000-0000000000a1", displayName: "Maya Presenter" },
  theo: { userId: "00000000-0000-7000-8000-0000000000a2", displayName: "Theo Park" },
  priya: { userId: "00000000-0000-7000-8000-0000000000a3", displayName: "Priya Raman" },
};

const SAY = { kind: "say" as const, text: "Here is what I found." };
const ROLES = ["presenter", "theo", "priya"];

function pack(steps: unknown[], verify = ["presenter"]) {
  return DemoPackSchema.safeParse({
    version: "test", roles: ROLES, steps, verify,
    roleLabels: { theo: "Finance", priya: "Engineering" },
  });
}

function issues(result: ReturnType<typeof pack>): string[] {
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

function canvas(overrides: Record<string, unknown> = {}) {
  return {
    kind: "create_canvas", id: "open", canvas: "review", as: "theo", title: "Q4 revenue review",
    sharedWith: ["priya"], prompt: "Draft the review.", assistant: SAY, ...overrides,
  };
}

function sidekick(overrides: Record<string, unknown> = {}) {
  return {
    kind: "sidekick", id: "changelog", sidekick: "changelog", as: "theo", sharedWith: "organization",
    name: "Weekly changelog", description: "Writes the changelog.", overview: "Every Friday.",
    instructions: "Write the changelog.",
    schedule: { rrule: "FREQ=WEEKLY;BYDAY=FR;BYHOUR=14;BYMINUTE=0;BYSECOND=0", timezone: "America/Los_Angeles", summary: "Fridays" },
    ...overrides,
  };
}

describe("the pack schema", () => {
  it("accepts the placeholder pack, which has no Thread, Channel or Breakout step", () => {
    const parsed = DemoPackSchema.parse(PLACEHOLDER_DEMO_PACK);
    expect([...new Set(parsed.steps.map((step) => step.kind))].sort()).toEqual([
      "canvas_artifact", "canvas_message", "create_canvas", "sidekick", "sidekick_message", "upload",
    ]);
    // The mockup's Organization: what the presenter is offered.
    const facts = packCanvasFacts(parsed.steps);
    expect(visibleCanvasesFor("presenter", facts.values()).map((facts) => facts.title))
      .toEqual(["Q4 revenue review", "Launch plan", "Weekly changelog · Nov 6"]);
    expect(visibleSidekicksFor("presenter", packSidekickFacts(parsed.steps)).map((facts) => facts.name))
      .toEqual(["Weekly changelog", "Incident triage"]);
    // Two versions of the review, both Rally's.
    expect([...facts.get("q4-review")!.artifacts]).toEqual([["q4-revenue-review.md", 2]]);
  });

  it("refuses a Canvas used before it is made, and two Canvases or Sidekicks under one name", () => {
    expect(issues(pack([{ kind: "canvas_message", id: "early", canvas: "review", as: "theo", text: "Hello" }])))
      .toEqual(['Canvas "review" is used before it is made']);
    expect(issues(pack([canvas(), sidekick({ sidekick: "review" })])))
      .toEqual(['"review" names two Canvases or Sidekicks']);
  });

  it("refuses a line from somebody the Canvas does not admit, and admits everyone in an Organization Canvas", () => {
    expect(issues(pack([canvas(), { kind: "canvas_message", id: "line", canvas: "review", as: "presenter", text: "Hi" }])))
      .toEqual(['Role "presenter" cannot open Canvas "review"']);
    expect(pack([canvas({ sharedWith: "organization" }), { kind: "canvas_message", id: "line", canvas: "review", as: "presenter", text: "Hi" }]).success)
      .toBe(true);
  });

  it("refuses a publish in a Canvas where Rally has not run, and an answer with no prompt", () => {
    const artifact = { kind: "canvas_artifact", id: "v1", canvas: "review", path: "review.md", title: "Review", content: "# Review" };
    expect(issues(pack([canvas({ prompt: undefined, assistant: undefined }), artifact])))
      .toEqual(['Rally has not run in Canvas "review" to publish this']);
    expect(issues(pack([canvas({ prompt: undefined })]))).toEqual(["Rally answers a prompt, and there is none"]);
    expect(pack([canvas(), artifact]).success).toBe(true);
  });

  it("refuses a Canvas that carries on after its question", () => {
    expect(issues(pack([
      canvas({ assistant: { kind: "ask", prompt: "Which one?", options: ["A", "B"] } }),
      { kind: "canvas_message", id: "after", canvas: "review", as: "priya", text: "Still here." },
    ]))).toEqual(['Canvas "review" continues after its question']);
  });

  it("refuses a name in prose nobody plays, the creator in their own audience, and a step id used twice", () => {
    expect(issues(pack([canvas({ assistant: { kind: "say", text: "Ask @{dana}." } })])))
      .toEqual(['Named role "dana" is not in the cast']);
    expect(issues(pack([canvas({ sharedWith: ["theo"] })]))).toEqual(["The creator is in it already"]);
    expect(issues(pack([canvas(), canvas({ canvas: "other" })]))).toEqual(['Step id "open" is used twice']);
  });

  it("refuses a Sidekick's Canvas with no run to write it, and a message from somebody it is not shared with", () => {
    expect(issues(pack([sidekick({ canvas: { title: "Changelog", path: "changelog.md", content: "# Changelog" } })])))
      .toEqual(["A Sidekick's Canvas is written by a run, and it has none"]);
    expect(issues(pack([
      sidekick({ sharedWith: ["priya"] }),
      { kind: "sidekick_message", id: "reply", sidekick: "changelog", as: "presenter", text: "Thanks." },
    ]))).toEqual(['Role "presenter" cannot open Sidekick "changelog"']);
    expect(issues(pack([{ kind: "sidekick_message", id: "reply", sidekick: "changelog", as: "theo", text: "Thanks." }])))
      .toEqual(['Sidekick "changelog" is used before it is published']);
  });

  it("refuses a viewer nobody plays, and refuses a pack that verifies nobody", () => {
    expect(issues(pack([canvas()], ["dana"]))).toEqual(['Viewer "dana" is not in the cast']);
    expect(pack([canvas()], []).success).toBe(false);
  });
});

describe("what a pack makes visible", () => {
  it("offers a Sidekick's Canvas to whoever the Sidekick is shared with, and nobody else", () => {
    const parsed = DemoPackSchema.parse({
      version: "test", roles: ROLES, verify: ["presenter"], roleLabels: { theo: "Finance", priya: "Engineering" },
      steps: [sidekick({ sharedWith: ["presenter"], firstRun: SAY, canvas: { title: "Changelog", path: "changelog.md", content: "# Changelog" } })],
    });
    const facts = packCanvasFacts(parsed.steps);
    expect(facts.get("changelog")).toMatchObject({ writer: "changelog", creator: "theo", artifacts: new Map([["changelog.md", 1]]) });
    expect(visibleCanvasesFor("presenter", facts.values())).toHaveLength(1);
    expect(visibleCanvasesFor("priya", facts.values())).toHaveLength(0);
  });
});

describe("planning a pack against a cast", () => {
  it("resolves audiences to user ids and names to display names, and carries each run's script", () => {
    const parsed = DemoPackSchema.parse({
      version: "test", roles: ROLES, verify: ["presenter"], roleLabels: { theo: "Finance", priya: "Engineering" },
      steps: [
        canvas({ assistant: { kind: "say", text: "Done, @{priya}." } }),
        { kind: "canvas_artifact", id: "v1", canvas: "review", path: "review.md", title: "Review", content: "Owner: @{priya}" },
        { kind: "canvas_message", id: "line", canvas: "review", as: "priya", text: "Thanks @{theo}." },
        sidekick({ sharedWith: ["presenter", "priya"], firstRun: SAY }),
        { kind: "sidekick_message", id: "reply", sidekick: "changelog", as: "priya", text: "Seen it." },
      ],
    });
    const [open, artifact, line, published, reply] = planDemoSeed(parsed, CAST);
    expect(open).toMatchObject({
      kind: "create_canvas", actorUserId: CAST.theo!.userId, audience: { userIds: [CAST.priya!.userId] },
      prompt: { text: "Draft the review.", seed: { packVersion: "test", actionId: "open", assistant: { kind: "say", text: "Done, Priya Raman." } } },
    });
    // Published by the run Theo's prompt started, so as Theo.
    expect(artifact).toMatchObject({ kind: "canvas_artifact", actorUserId: CAST.theo!.userId, content: "Owner: Priya Raman" });
    expect(line).toMatchObject({ kind: "canvas_message", text: "Thanks Theo Park.", seed: { assistant: null } });
    expect(published).toMatchObject({
      kind: "sidekick", audience: { userIds: [CAST.presenter!.userId, CAST.priya!.userId] },
      firstRun: { actionId: "changelog", assistant: SAY }, canvas: null,
    });
    expect(reply).toMatchObject({ kind: "sidekick_message", sidekick: "changelog", seed: { assistant: null } });
  });

  it("refuses a cast that leaves a role unbound", () => {
    const parsed = DemoPackSchema.parse(PLACEHOLDER_DEMO_PACK);
    expect(() => planDemoSeed(parsed, { presenter: CAST.presenter!, theo: CAST.theo! })).toThrow("demo_pack_role_unbound:priya");
  });
});
