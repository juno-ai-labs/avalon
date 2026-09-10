import { describe, expect, it } from "vitest";

import {
  DemoPackSchema,
  PLACEHOLDER_DEMO_PACK,
  demoIdleViewerExpectation,
  packRoomFacts,
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

/** A label per role the operator casts; the schema requires one each. */
function roleLabels(roles: string[]): Record<string, string> {
  return Object.fromEntries(roles.filter((role) => role !== "presenter").map((role) => [role, `The ${role} part`]));
}

function pack(steps: unknown[], roles = ["presenter", "priya", "marcus", "dana"]) {
  return DemoPackSchema.safeParse({ version: "test", roles, steps, roleLabels: roleLabels(roles) });
}

function parsedPack(steps: unknown[], roles = ["presenter", "priya", "marcus"]) {
  return DemoPackSchema.parse({ version: "test", roles, steps, roleLabels: roleLabels(roles) });
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
    expect(rooms.map((step) => step.room))
      .toEqual(["decision-memo", "northgate-renewal", "press-release"]);
    // The pack's one question, in the renewal room, is the demo's opening beat:
    // nothing said after it in that room, and no second question anywhere.
    const asks = PLACEHOLDER_DEMO_PACK.steps.filter(
      (step) => (step.kind === "create_workstream" || step.kind === "message") && step.assistant?.kind === "ask",
    );
    expect(asks.map((step) => step.id)).toEqual(["renewal-marcus-2"]);
    // And one standing Sidekick, published and on a schedule, with one run
    // already behind it.
    const sidekicks = PLACEHOLDER_DEMO_PACK.steps.filter((step) => step.kind === "sidekick");
    expect(sidekicks.map((step) => [step.name, step.scope, step.schedule.timezone, step.firstRun !== undefined]))
      .toEqual([["Morning briefing", "workspace", "America/Los_Angeles", true]]);
    // The press-release room's private child, which the presenter is in
    // without being in its parent.
    const children = PLACEHOLDER_DEMO_PACK.steps.filter((step) => step.kind === "create_substream");
    expect(children.map((step) => [step.room, step.substream, step.participants]))
      .toEqual([["press-release", "placement", ["priya", "dana", "presenter"]]]);
  });

  it("expects of the presenter exactly what an idle viewer's flags derive to", () => {
    // The pack's `expect` block is the one thing in it that no test and no
    // schema rule can otherwise contradict: a wrong flag parses, plans and
    // seeds, and then leaves every demo prepared from this pack waiting in
    // **Waiting for workspace** for a projection the platform will never
    // produce. The presenter acts in no room, so the flags are derivable, and
    // this is the comparison that keeps the checked-in pack honest.
    expect(PLACEHOLDER_DEMO_PACK.expect)
      .toEqual([demoIdleViewerExpectation(PLACEHOLDER_DEMO_PACK.steps, "presenter")]);
  });

  it("derives an idle viewer's flags from the steps, and refuses a viewer who acted", () => {
    const steps = [
      // Workspace-scoped and the viewer is not in it: offered, unread, and
      // waiting on nobody however it ends.
      open({ id: "quiet", room: "quiet", as: "priya", participants: ["marcus"] }),
      // The viewer is seated by a mention, and the room parks on a question.
      open({ id: "loud", room: "loud", as: "priya", participants: [], openingMessage: "@{presenter} weigh in." }),
      {
        kind: "message", id: "loud-ask", room: "loud", as: "priya", text: "Rally, settle it.",
        assistant: { kind: "ask", prompt: "Which one?", options: ["This", "That"] },
      },
    ];
    expect(demoIdleViewerExpectation(parsedPack(steps).steps, "presenter")).toEqual({
      viewer: "presenter",
      // One seated room, and the mention outranks the unanswered question in it.
      attention: { waitingForYou: 1, waitingReason: "mentioned" },
      rooms: {
        quiet: { unseen: false, hasUnread: true, mentioned: false },
        loud: { unseen: true, hasUnread: true, mentioned: true },
      },
    });
    // Acting in a room's main conversation opens it, so the flags stop being a
    // fact about the pack; such a viewer states them by hand.
    expect(() => demoIdleViewerExpectation(parsedPack(steps).steps, "priya"))
      .toThrow(/demo_pack_viewer_is_not_idle:priya/u);
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

  it("refuses a pack whose parts cannot be labelled: a role with no label, one nobody casts", () => {
    // The labels are what the New demo form's dropdowns are titled, so a
    // missing one is a part the operator casts a real colleague into with
    // nothing telling them which part it is — found here, not in Ace.
    const parse = (labels: Record<string, string>) => DemoPackSchema.safeParse({
      version: "test", roles: ["presenter", "priya", "marcus"], steps: [open()], roleLabels: labels,
    });
    expect(issues(parse({ priya: "Product" }))).toContain('Role "marcus" has no label');
    expect(issues(parse({ priya: "Product", marcus: "Sales", presenter: "Presenting" })))
      .toContain('"presenter" is not a role the operator casts');
    expect(parse({ priya: "Product", marcus: "Sales" }).success).toBe(true);
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

/**
 * A substream is a second conversation inside a room, with its own roster and
 * its own question. Every rule the main conversation has, it has separately —
 * and one it does not: nothing said in it can seat anybody, because the roster
 * belongs to the parent object rather than to the message.
 */
describe("a pack's substreams", () => {
  function child(overrides: Record<string, unknown> = {}) {
    return {
      kind: "create_substream",
      id: "aside",
      room: "room",
      substream: "aside",
      as: "priya",
      title: "An aside",
      participants: ["marcus"],
      startingContext: "Where this left off.",
      ...overrides,
    };
  }

  it("refuses a substream of a room that does not exist yet", () => {
    expect(issues(pack([child(), open()])))
      .toContain('Room "room" is used before it is created');
  });

  it("refuses the same substream name twice, and the creator listed as a participant", () => {
    expect(issues(pack([open(), child(), child({ id: "again" })])))
      .toEqual(expect.arrayContaining(['Substream "aside" is created twice']));
    expect(issues(pack([open(), child({ participants: ["priya"] })])))
      .toContain("The creator is in it already");
  });

  it("refuses a line in a substream from somebody who is only in its parent", () => {
    // Being in the work stream is not being in its private child, and the
    // parent object says so explicitly rather than inferring one from the
    // other. A pack that leans on it would be leaning on nothing.
    expect(issues(pack([
      open({ participants: ["marcus", "dana"] }),
      child(),
      { kind: "message", id: "line", room: "room", substream: "aside", as: "dana", text: "Me too." },
    ]))).toContain('Role "dana" is not in room "room/aside"');
  });

  it("refuses a mention in a substream of somebody who is not in it", () => {
    // In a work stream a confirmed mention seats the person. A message cannot
    // do that to a private child's roster, so the mention would land on
    // somebody who never sees it.
    expect(issues(pack([
      open({ participants: ["marcus", "dana"] }),
      child(),
      { kind: "message", id: "line", room: "room", substream: "aside", as: "priya", text: "@{dana} thoughts?" },
    ]))).toContain('Role "dana" is mentioned in substream "room/aside" without being in it');
  });

  it("lets a workspace room put anybody in its substream, and a personal room only its own", () => {
    // The parent refuses whoever it would not let read the work stream, and
    // that is decided by scope: a workspace room admits every member.
    expect(pack([open(), child({ participants: ["marcus", "dana"] })]).success).toBe(true);
    expect(issues(pack([
      open({ scope: "personal" }),
      child({ participants: ["marcus", "dana"] }),
    ]))).toContain('Role "dana" cannot be put in a substream of personal room "room" without being in it');
  });

  it("counts questions per conversation, not per room", () => {
    // A parked question in the child does not park the parent, and a parked
    // parent does not stop the child. Each conversation ends once.
    expect(pack([
      open(),
      child(),
      { kind: "message", id: "child-ask", room: "room", substream: "aside", as: "priya", text: "Decide.", assistant: { kind: "ask", prompt: "Which?", options: ["A", "B"] } },
      { kind: "message", id: "parent-line", room: "room", as: "priya", text: "Back in the main room." },
    ]).success).toBe(true);
    expect(issues(pack([
      open(),
      child(),
      { kind: "message", id: "child-ask", room: "room", substream: "aside", as: "priya", text: "Decide.", assistant: { kind: "ask", prompt: "Which?", options: ["A", "B"] } },
      { kind: "message", id: "child-after", room: "room", substream: "aside", as: "marcus", text: "Also..." },
    ]))).toContain('Room "room/aside" continues after its question');
  });

  it("refuses a role the starting context names that the cast does not bind", () => {
    expect(issues(pack([open(), child({ startingContext: "@{sam} raised it." })])))
      .toContain('The starting context names role "sam", which is not in the cast');
  });

  it("keeps a substream out of the room's facts entirely", () => {
    // The readiness barrier builds what it waits for from these. A private
    // child takes no directory row and its activity never reaches the parent's,
    // so a substream step that moved the room's recency, seats, state or
    // attachments would make the barrier wait for a projection that is never
    // coming.
    const parsed = parsedPack([
      open(),
      { kind: "message", id: "parent-line", room: "room", as: "priya", text: "In the main room." },
      child(),
      { kind: "upload", id: "child-doc", room: "room", substream: "aside", as: "priya", title: "Aside", fileName: "a.md", mimeType: "text/markdown", content: "# Aside\n" },
      { kind: "message", id: "child-ask", room: "room", substream: "aside", as: "priya", text: "Decide.", assistant: { kind: "ask", prompt: "Which?", options: ["A", "B"] } },
    ]);
    const facts = packRoomFacts(parsed.steps).get("room");
    expect(facts).toMatchObject({
      seated: ["priya", "marcus"],
      // The main room's own last step, not the child's three after it.
      lastStepIndex: 1,
      finalState: "completed",
      uploads: [],
    });
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

  it("addresses a substream by name and expands the roles in its starting context", () => {
    const parsed = parsedPack([
      open(),
      {
        kind: "create_substream", id: "aside", room: "room", substream: "aside", as: "priya",
        title: "An aside", participants: ["marcus"],
        startingContext: "@{marcus} asked where this left off.",
      },
      { kind: "message", id: "line", room: "room", substream: "aside", as: "priya", text: "@{marcus} here." },
    ]);
    const [, child, line] = planDemoSeed(parsed, CAST);
    expect(child).toMatchObject({
      kind: "create_substream",
      room: "room",
      substream: "aside",
      actorUserId: CAST.priya!.userId,
      participantUserIds: [CAST.marcus!.userId],
      startingContext: "Marcus Hale asked where this left off.",
    });
    // The room's own steps stay addressed to its main conversation.
    expect(planDemoSeed(parsed, CAST)[0]).toMatchObject({ substream: null });
    // A mention in a child is real text, but confirms nobody: the child's
    // roster is the parent object's and a message cannot add to it.
    expect(line).toMatchObject({
      kind: "message",
      substream: "aside",
      text: "@Marcus Hale here.",
      confirmedParticipantUserIds: [],
    });
  });

  it("refuses a cast that leaves a role unbound", () => {
    const parsed = parsedPack([open()]);
    const partial = Object.fromEntries(Object.entries(CAST).filter(([role]) => role !== "marcus"));
    expect(() => planDemoSeed(parsed, partial)).toThrow("demo_pack_role_unbound:marcus");
  });
});
