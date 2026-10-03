import { describe, expect, it } from "vitest";

import { PLACEHOLDER_DEMO_PACK } from "../src/services/demo-pack";
import { builtinDemoPack, checkDemoPack, previewDemoPack } from "../src/services/demo-scenarios";

/**
 * The check a Demo MCP client runs on a pack it wrote: the schema's rules by
 * stable code with a fixed sentence, a path that withholds the author's keys,
 * the presenter's view derived when it can be, and a preview of what the
 * presenter will read.
 */

const SAY = { kind: "say" as const, text: "Here is what I found." };

function room(overrides: Record<string, unknown> = {}) {
  return {
    kind: "create_workstream",
    id: "open",
    room: "northwind",
    as: "priya",
    title: "Warehouse selection",
    participants: ["marcus"],
    scope: "workspace",
    openingMessage: "Start here, @{presenter}.",
    assistant: SAY,
    ...overrides,
  };
}

function pack(overrides: Record<string, unknown> = {}) {
  return {
    version: "northwind-1",
    roles: ["presenter", "priya", "marcus"],
    roleLabels: { priya: "Operations", marcus: "Sales" },
    steps: [room()],
    ...overrides,
  };
}

describe("checking a scenario pack", () => {
  it("accepts the built-in pack unchanged and counts what preparation will do", async () => {
    const result = await checkDemoPack(PLACEHOLDER_DEMO_PACK);
    expect(result).toMatchObject({
      ok: true,
      summary: { spaces: 3, channels: 4, breakouts: 3, sidekicks: 1, parts: ["priya", "marcus", "dana"] },
    });
    // The presenter's entry is the derived one, which is what the shipped
    // pack already states.
    expect(result.ok && result.pack.expect).toEqual(builtinDemoPack().expect);
  });

  it("derives the presenter's view when they never act, and puts it in place of a wrong one", async () => {
    const wrong = {
      viewer: "presenter",
      attention: { waitingForYou: 0, waitingReason: null },
      rooms: { northwind: { unseen: false, hasUnread: false, mentioned: false } },
    };
    const result = await checkDemoPack(pack({ expect: [wrong] }));
    expect(result).toMatchObject({
      ok: true,
      derived: ["expect[0]"],
      pack: {
        expect: [{
          viewer: "presenter",
          attention: { waitingForYou: 1, waitingReason: "mentioned" },
          rooms: { northwind: { unseen: true, hasUnread: true, mentioned: true } },
        }],
      },
    });
  });

  it("asks for the presenter's view when they act, rather than throwing mid-check", async () => {
    const result = await checkDemoPack(pack({
      steps: [room({ as: "presenter", participants: ["priya"], openingMessage: "Kick off." })],
    }));
    expect(result).toEqual({
      ok: false,
      issues: [{
        path: "expect",
        code: "demo_pack_presenter_expect_required",
        message: "The presenter speaks or acts in a room, so their view cannot be derived. Add an expect entry for presenter.",
      }],
    });
  });

  it("reports a rule by its code and a fixed sentence that quotes nothing from the pack", async () => {
    const result = await checkDemoPack(pack({
      steps: [
        room(),
        { kind: "message", id: "aside", room: "northwind", as: "zeppelin-ops", text: "Hello." },
      ],
    }));
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          path: "steps[1]",
          code: "demo_pack_role_not_in_cast",
          message: "This role is not in the pack's roles. Add it to roles and roleLabels, or name a role that is.",
        },
        {
          path: "steps[1].as",
          code: "demo_pack_speaker_not_seated",
          message: "The speaker is not in this conversation. Add them to the room's participants or mention them earlier, or choose someone who is in it.",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("zeppelin-ops");
  });

  it("shows a key inside a record by its position, never by name", async () => {
    const result = await checkDemoPack(pack({
      roleLabels: { priya: "Operations", marcus: "Sales", "secret-codename": "Nobody" },
    }));
    expect(result).toEqual({
      ok: false,
      issues: [{
        path: "roleLabels{2}",
        code: "demo_pack_role_label_unused",
        message: "This label is for a role the operator does not cast. Remove it, or add the role to roles.",
      }],
    });
  });

  it("reports a shape failure by path and Zod code, without the rejected value or an unknown key's name", async () => {
    const result = await checkDemoPack(pack({ steps: [room({ title: 42, smuggled: "x" })] }));
    expect(result).toMatchObject({ ok: false });
    const issues = result.ok ? [] : result.issues;
    expect(issues.map((issue) => [issue.path, issue.code])).toEqual([
      ["steps[0].title", "invalid_type"],
      ["steps[0]", "unrecognized_keys"],
    ]);
    expect(JSON.stringify(issues)).not.toContain("smuggled");
  });

  it("refuses a personal room before anything is written", async () => {
    const result = await checkDemoPack(pack({ steps: [room({ scope: "personal" })] }));
    expect(result).toEqual({
      ok: false,
      issues: [{
        path: "steps[0].scope",
        code: "demo_pack_personal_room_unsupported",
        message: "Rooms must have scope workspace; seeding refuses a personal room. Change the scope to workspace.",
      }],
    });
  });
});

describe("previewing a scenario", () => {
  it("reads as the presenter will see it, with the cast's names or the part's label", async () => {
    const result = await checkDemoPack(pack({
      spaces: { customer: { as: "marcus", name: "Customer: Northwind", iconKey: "handshake", colorKey: "blue" } },
      steps: [
        room({ space: "customer" }),
        { kind: "message", id: "reply", room: "northwind", as: "marcus", text: "Budget is $40k." },
      ],
    }));
    if (!result.ok) throw new Error("the pack should check");
    expect(previewDemoPack(result.pack, { priya: "Sam Lee" })).toBe([
      "## Customer: Northwind",
      "",
      "### Warehouse selection · seated, new, mentioned",
      "",
      "**Sam Lee:** Start here, @[Presenter].",
      "",
      "**Rally:** Here is what I found.",
      "",
      "**[Sales]:** Budget is $40k.",
      "",
    ].join("\n"));
  });
});
