import { describe, expect, it } from "vitest";

import {
  DemoPackSchema,
  PLACEHOLDER_DEMO_PACK,
  planDemoSeed,
  type DemoCast,
} from "../src/services/demo-pack";

/**
 * A pack is playable or it is refused before the first write.
 *
 * The rules here are the ones a bad pack would otherwise break against the
 * production path three actions in: a room used before it exists, a line said
 * by somebody not in the room, a mention of somebody not in the cast, a room
 * that carries on after its question. Each is a parse-time refusal so the
 * operator sees it as "bad pack" rather than as a half-seeded workspace.
 */

const CAST: DemoCast = {
  presenter: { userId: "00000000-0000-7000-8000-0000000000a1", displayName: "Adam Presenter" },
  priya: { userId: "00000000-0000-7000-8000-0000000000a2", displayName: "Priya Raman" },
  marcus: { userId: "00000000-0000-7000-8000-0000000000a3", displayName: "Marcus Hale" },
  dana: { userId: "00000000-0000-7000-8000-0000000000a4", displayName: "Dana Okafor" },
};

const SAY = { kind: "say" as const, text: "Here is what I found." };

/** A default name per role the operator names; the schema requires one each. */
function castDefaults(roles: string[]): Record<string, string> {
  return Object.fromEntries(roles.filter((role) => role !== "presenter").map((role) => [role, CAST[role]!.displayName]));
}

function pack(steps: unknown[], roles = ["presenter", "priya", "marcus", "dana"]) {
  return DemoPackSchema.safeParse({ version: "test", roles, steps, castDefaults: castDefaults(roles) });
}

function parsedPack(steps: unknown[], roles = ["presenter", "priya", "marcus"]) {
  return DemoPackSchema.parse({ version: "test", roles, steps, castDefaults: castDefaults(roles) });
}

function open(overrides: Record<string, unknown> = {}) {
  return {
    kind: "create_workstream",
    id: "open",
    room: "room",
    as: "priya",
    title: "A room",
    participants: ["marcus"],
    scope: "workspace",
    openingMessage: "Start here.",
    assistant: SAY,
    ...overrides,
  };
}

function sidekick(overrides: Record<string, unknown> = {}) {
  return {
    kind: "sidekick",
    id: "briefing",
    as: "priya",
    scope: "workspace",
    name: "Morning briefing",
    description: "Posts a short briefing each weekday morning.",
    overview: "Every weekday at 9am Pacific it writes one briefing.",
    instructions: "Write one briefing each weekday morning.",
    schedule: {
      rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
      timezone: "America/Los_Angeles",
      summary: "Every weekday at 9:00am Pacific",
    },
    ...overrides,
  };
}

function issues(result: ReturnType<typeof pack>): string[] {
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe("the pack schema", () => {
  it("accepts the placeholder pack", () => {
    // A literal, parsed here and the first time a demo asks for it — never at
    // module load, where a bad pack took the whole Worker down. This is the
    // check that keeps the checked-in pack playable.
    const parsed = DemoPackSchema.safeParse(PLACEHOLDER_DEMO_PACK);
    expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)).toEqual([]);
    const rooms = PLACEHOLDER_DEMO_PACK.steps.filter((step) => step.kind === "create_workstream");
    expect(rooms.map((step) => step.room)).toEqual(["decision-memo", "northgate-renewal"]);
    // The demo's punchline: the last thing said in a room is a question the
    // presenter answers, which is the one real run a demo makes.
    const lastSpoken = PLACEHOLDER_DEMO_PACK.steps.filter((step) => step.kind === "message").at(-1);
    expect(lastSpoken?.assistant?.kind).toBe("ask");
    // And one standing Sidekick, published and on a schedule, with one run
    // already behind it.
    const sidekicks = PLACEHOLDER_DEMO_PACK.steps.filter((step) => step.kind === "sidekick");
    expect(sidekicks.map((step) => [step.name, step.scope, step.schedule.timezone, step.firstRun !== undefined]))
      .toEqual([["Morning briefing", "workspace", "America/Los_Angeles", true]]);
  });

  it("takes a Sidekick that is in no room, and refuses two under one name", () => {
    // A Sidekick names no room, and the room rules the other steps live under
    // do not apply to it — this one is the only step in the pack.
    expect(issues(pack([sidekick()]))).toEqual([]);
    expect(issues(pack([sidekick(), sidekick({ id: "briefing-2" })])))
      .toEqual([`Two Sidekicks are named "Morning briefing"`]);
    // A different name is two Sidekicks, which is allowed.
    expect(issues(pack([sidekick(), sidekick({ id: "briefing-2", name: "Evening wrap" })]))).toEqual([]);
  });

  it("refuses a Sidekick whose own prose names somebody nobody plays", () => {
    // The tokens are expanded when the cast is bound, which is mid-seeding —
    // long after the point at which refusing costs nothing.
    expect(issues(pack([sidekick({ instructions: "Ask @{nobody} before posting." })])))
      .toEqual([`The Sidekick's prose names role "nobody", which is not in the cast`]);
    expect(issues(pack([sidekick({ firstRun: { kind: "say", text: "@{nobody} owns this." } })])))
      .toEqual([`The Sidekick's prose names role "nobody", which is not in the cast`]);
  });

  it("plans a Sidekick with its prose bound to the cast and its briefing carried as a seed", () => {
    const planned = planDemoSeed(
      parsedPack([sidekick({
        instructions: "Ask @{marcus} before posting.",
        firstRun: { kind: "say", text: "@{presenter} owns the Northgate call." },
      })]),
      CAST,
    );
    expect(planned).toEqual([{
      kind: "sidekick",
      actionId: "briefing",
      actorUserId: CAST.priya!.userId,
      scope: "workspace",
      definition: expect.objectContaining({
        name: "Morning briefing",
        // A bare name, with no mention: Rally's own prose names people the way
        // a model would, and a Sidekick's instructions seat nobody.
        instructions: "Ask Marcus Hale before posting.",
      }),
      schedule: {
        rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
        timezone: "America/Los_Angeles",
        summary: "Every weekday at 9:00am Pacific",
      },
      firstRun: {
        packVersion: "test",
        actionId: "briefing",
        assistant: { kind: "say", text: "Adam Presenter owns the Northgate call." },
      },
    }]);
  });

  it("refuses a pack whose cast cannot be named: a role with no default, one nobody plays, two alike", () => {
    // The defaults are what the New demo form opens with, so a missing one is
    // an empty field the operator has to fill in blind and two alike are a
    // form that cannot be submitted — both found here, not in Ace.
    const parse = (castDefaults: Record<string, string>) => DemoPackSchema.safeParse({
      version: "test", roles: ["presenter", "priya", "marcus"], steps: [open()], castDefaults,
    });
    expect(issues(parse({ priya: "Priya Raman" }))).toContain('Role "marcus" has no default name');
    expect(issues(parse({ priya: "Priya Raman", marcus: "Marcus Hale", presenter: "Adam" })))
      .toContain('"presenter" is not a role the operator names');
    expect(issues(parse({ priya: "Priya Raman", marcus: "Priya Raman" }))).toContain("Default names must differ");
  });

  it("refuses a room used before it is created", () => {
    expect(issues(pack([
      { kind: "message", id: "early", room: "room", as: "priya", text: "Hello?" },
      open(),
    ]))).toContain('Room "room" is used before it is created');
  });

  it("refuses a line from somebody who is not in the room", () => {
    expect(issues(pack([
      open(),
      { kind: "message", id: "dana-1", room: "room", as: "dana", text: "I was never seated." },
    ]))).toContain('Role "dana" is not in room "room"');
  });

  it("seats a mentioned member, so they can speak afterwards", () => {
    expect(pack([
      open(),
      { kind: "message", id: "priya-1", room: "room", as: "priya", text: "@{dana} can you weigh in?" },
      { kind: "message", id: "dana-1", room: "room", as: "dana", text: "Yes." },
    ]).success).toBe(true);
  });

  it("refuses a mention of somebody who is not in the cast", () => {
    expect(issues(pack([
      open({ openingMessage: "@{sam} look at this" }),
    ]))).toContain('Mentioned role "sam" is not in the cast');
  });

  it("refuses a role Rally's own prose names that the cast does not bind, in a say and in an ask", () => {
    // These tokens are dereferenced when the seed is planned — mid-seeding,
    // after the workspace exists and the connections are copied — so an
    // unbound one has to be a parse-time refusal like the human lines' are.
    expect(issues(pack([
      open({ assistant: { kind: "say", text: "@{sam} raised a good point." } }),
    ]))).toContain('Rally\'s turn names role "sam", which is not in the cast');
    expect(issues(pack([
      open(),
      { kind: "message", id: "m", room: "room", as: "priya", text: "Well?", assistant: { kind: "ask", prompt: "Which?", options: ["@{sam} is right", "Nobody"] } },
    ]))).toContain('Rally\'s turn names role "sam", which is not in the cast');
  });

  it("refuses a room that carries on after its question", () => {
    expect(issues(pack([
      open(),
      {
        kind: "message", id: "ask", room: "room", as: "marcus", text: "Rally, decide.",
        assistant: { kind: "ask", prompt: "Which?", options: ["A", "B"] },
      },
      { kind: "message", id: "after", room: "room", as: "priya", text: "Also..." },
    ]))).toContain('Room "room" continues after its question');
  });

  it("refuses a step id used twice and a room created twice", () => {
    const result = pack([open(), open()]);
    expect(issues(result)).toEqual(expect.arrayContaining([
      'Step id "open" is used twice',
      'Room "room" is created twice',
    ]));
  });

  it("seats a person alone with Rally, because the seed decides what starts a run", () => {
    // `participants` may be empty: whether a seeded line starts a run is the
    // seed's decision, not the room's size, so a solo room is an ordinary one.
    expect(pack([open({ participants: [] })]).success).toBe(true);
  });
});

describe("planning a pack against a cast", () => {
  it("resolves a mention to the bound member, at the offsets of the expanded name", () => {
    const parsed = parsedPack([
      open(),
      { kind: "message", id: "priya-1", room: "room", as: "priya", text: "@{presenter} you own this call." },
    ]);
    const [, message] = planDemoSeed(parsed, CAST);
    expect(message?.kind).toBe("message");
    if (message?.kind !== "message") return;
    expect(message.text).toBe("@Adam Presenter you own this call.");
    expect(message.mentions).toEqual([{
      type: "person",
      userId: CAST.presenter!.userId,
      connectorType: null,
      startOffset: 0,
      endOffset: "@Adam Presenter".length,
    }]);
    // A confirmed mention is what seats the presenter in the room.
    expect(message.confirmedParticipantUserIds).toEqual([CAST.presenter!.userId]);
    // A message with no `assistant` starts no run, and says so on its seed.
    expect(message.seed).toEqual({ packVersion: "test", actionId: "priya-1", assistant: null });
  });

  it("expands the roles in Rally's own prose to bare names, with no mention", () => {
    // The shipped pack's closing question names three cast members this way;
    // nothing else exercised the resolver that turns them into people.
    const parsed = parsedPack([
      open({ assistant: { kind: "say", text: "@{priya} and @{marcus} disagree." } }),
      { kind: "message", id: "ask", room: "room", as: "marcus", text: "Decide.", assistant: { kind: "ask", prompt: "@{priya} would hold; which?", options: ["Side with @{priya}", "Side with @{marcus}"] } },
    ]);
    const [opening, ask] = planDemoSeed(parsed, CAST);
    expect(opening?.kind).toBe("create_workstream");
    expect(ask?.kind).toBe("message");
    if (opening?.kind !== "create_workstream" || ask?.kind !== "message") return;
    expect(opening.seed.assistant).toEqual({ kind: "say", text: "Priya Raman and Marcus Hale disagree." });
    expect(ask.seed.assistant).toEqual({
      kind: "ask",
      prompt: "Priya Raman would hold; which?",
      options: ["Side with Priya Raman", "Side with Marcus Hale"],
    });
  });

  it("seats the named participants by id and carries the opening script", () => {
    const parsed = parsedPack([open()]);
    const [create] = planDemoSeed(parsed, CAST);
    expect(create).toMatchObject({
      kind: "create_workstream",
      actionId: "open",
      actorUserId: CAST.priya!.userId,
      participantUserIds: [CAST.marcus!.userId],
      scope: "workspace",
      seed: { packVersion: "test", actionId: "open", assistant: SAY },
    });
  });

  it("refuses a cast that leaves a role unbound", () => {
    const parsed = parsedPack([open()]);
    const partial = Object.fromEntries(Object.entries(CAST).filter(([role]) => role !== "marcus"));
    expect(() => planDemoSeed(parsed, partial)).toThrow("demo_pack_role_unbound:marcus");
  });
});
