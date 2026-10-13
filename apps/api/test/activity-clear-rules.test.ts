import { describe, expect, it } from "vitest";

import {
  ACTIVITY_CLEAR_RULES,
  cleared,
  consultedSubjects,
  readsRole,
  type ActivityBindings,
  type ActivityRowFacts,
  type ActivitySubjectBinding,
} from "../src/durable-objects/activity-clear-rules";

const OCCURRED = 1_000;

const row = (roles: ActivityBindings): ActivityRowFacts => ({ roles, times: { occurred: OCCURRED } });

const conversation = (ordinals: ActivitySubjectBinding["ordinals"]): ActivityRowFacts => row({
  conversation: [{ key: "thread:t", ordinals }],
});

/** Waterlines read after the row occurred unless a time is given. */
const waterlines = (entries: Record<string, number | [number, number]>) => new Map(Object.entries(entries)
  .map(([key, value]) => [key, typeof value === "number" ? { through: value, at: OCCURRED + 1 } : { through: value[0], at: value[1] }]));

describe("a read clause", () => {
  it("holds once the subject's waterline reaches the ordinal, and not before", () => {
    const rule = { read: "conversation", through: "message" } as const;
    const facts = conversation({ opened: 0, message: 29 });
    expect(cleared(rule, facts, waterlines({ "thread:t": 28 }))).toBe(false);
    expect(cleared(rule, facts, waterlines({ "thread:t": 29 }))).toBe(true);
  });

  it("never holds for a subject with no waterline, even against an open", () => {
    expect(cleared({ read: "conversation", through: "opened" }, conversation({ opened: 0 }), waterlines({}))).toBe(false);
  });

  it("compares the first ordinal of a fallback chain the subject binds", () => {
    const rule = { read: "conversation", through: ["message", "opened"] } as const;
    expect(cleared(rule, conversation({ opened: 0, message: 5 }), waterlines({ "thread:t": 0 }))).toBe(false);
    expect(cleared(rule, conversation({ opened: 0 }), waterlines({ "thread:t": 0 }))).toBe(true);
  });

  it("never holds when the subject binds none of the ordinals named", () => {
    expect(cleared({ read: "conversation", through: "message" }, conversation({ opened: 0 }), waterlines({ "thread:t": 99 })))
      .toBe(false);
  });

  it("holds when any one subject bound to the role does, each against its own ordinal", () => {
    const facts = row({
      placement: [
        { key: "channel:a", ordinals: { placement: 4 } },
        { key: "channel:b", ordinals: { placement: 9 } },
      ],
    });
    const rule = { read: "placement", through: "placement" } as const;
    expect(cleared(rule, facts, waterlines({ "channel:a": 3, "channel:b": 8 }))).toBe(false);
    expect(cleared(rule, facts, waterlines({ "channel:a": 3, "channel:b": 9 }))).toBe(true);
  });

  it("never holds for a role the row does not bind", () => {
    expect(cleared({ read: "placement", through: "opened" }, row({}), waterlines({}))).toBe(false);
  });

  it("with since, needs the subject read at or after the row occurred, however far", () => {
    const rule = { read: "conversation", through: "opened", since: "occurred" } as const;
    const facts = conversation({ opened: 0 });
    expect(cleared(rule, facts, waterlines({ "thread:t": [40, OCCURRED - 1] }))).toBe(false);
    expect(cleared(rule, facts, waterlines({ "thread:t": [0, OCCURRED] }))).toBe(true);
  });
});

describe("any and all", () => {
  const opened = { read: "conversation", through: "opened" } as const;
  const message = { read: "conversation", through: "message" } as const;
  const facts = conversation({ opened: 0, message: 3 });
  const openedOnly = waterlines({ "thread:t": 0 });

  it("combine their clauses as or and and", () => {
    expect(cleared({ any: [opened, message] }, facts, openedOnly)).toBe(true);
    expect(cleared({ all: [opened, message] }, facts, openedOnly)).toBe(false);
    expect(cleared({ all: [opened, message] }, facts, waterlines({ "thread:t": 3 }))).toBe(true);
  });

  it("read empty as false and true", () => {
    expect(cleared({ any: [] }, facts, openedOnly)).toBe(false);
    expect(cleared({ all: [] }, facts, openedOnly)).toBe(true);
  });
});

describe("what a rule consults", () => {
  const roles: ActivityBindings = {
    conversation: [{ key: "thread:t", ordinals: { opened: 0 } }],
    placement: [{ key: "channel:a", ordinals: { placement: 1 } }],
  };

  it("names every subject the rule's roles bind, and only those", () => {
    expect(consultedSubjects(ACTIVITY_CLEAR_RULES.thread_started, roles)).toEqual(["thread:t", "channel:a"]);
    expect(consultedSubjects(ACTIVITY_CLEAR_RULES.mentioned, roles)).toEqual(["thread:t"]);
  });

  it("says which rules read the placement role", () => {
    expect(readsRole(ACTIVITY_CLEAR_RULES.thread_started, "placement")).toBe(true);
    expect(readsRole(ACTIVITY_CLEAR_RULES.run_finished, "placement")).toBe(false);
  });
});
