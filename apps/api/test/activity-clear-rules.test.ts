import { describe, expect, it } from "vitest";

import {
  ACTIVITY_CLEAR_RULES,
  cleared,
  consultedSubjects,
  readsRole,
  type ActivityBindings,
  type ActivitySubjectBinding,
} from "../src/durable-objects/activity-clear-rules";

const conversation = (ordinals: ActivitySubjectBinding["ordinals"]): ActivityBindings => ({
  conversation: [{ key: "thread:t", ordinals }],
});

const waterlines = (entries: Record<string, number>) => new Map(Object.entries(entries));

describe("a read clause", () => {
  it("holds once the subject's waterline reaches the ordinal, and not before", () => {
    const rule = { read: "conversation", through: "message" } as const;
    const bound = conversation({ opened: 0, message: 29 });
    expect(cleared(rule, bound, waterlines({ "thread:t": 28 }))).toBe(false);
    expect(cleared(rule, bound, waterlines({ "thread:t": 29 }))).toBe(true);
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
    const bound: ActivityBindings = {
      placement: [
        { key: "channel:a", ordinals: { placement: 4 } },
        { key: "channel:b", ordinals: { placement: 9 } },
      ],
    };
    const rule = { read: "placement", through: "placement" } as const;
    expect(cleared(rule, bound, waterlines({ "channel:a": 3, "channel:b": 8 }))).toBe(false);
    expect(cleared(rule, bound, waterlines({ "channel:a": 3, "channel:b": 9 }))).toBe(true);
  });

  it("never holds for a role the row does not bind", () => {
    expect(cleared({ read: "placement", through: "opened" }, {}, waterlines({}))).toBe(false);
  });
});

describe("any and all", () => {
  const opened = { read: "conversation", through: "opened" } as const;
  const latest = { read: "conversation", through: "latest" } as const;
  const bound = conversation({ opened: 0, latest: 3 });
  const openedOnly = waterlines({ "thread:t": 0 });

  it("combine their clauses as or and and", () => {
    expect(cleared({ any: [opened, latest] }, bound, openedOnly)).toBe(true);
    expect(cleared({ all: [opened, latest] }, bound, openedOnly)).toBe(false);
    expect(cleared({ all: [opened, latest] }, bound, waterlines({ "thread:t": 3 }))).toBe(true);
  });

  it("read empty as false and true", () => {
    expect(cleared({ any: [] }, bound, openedOnly)).toBe(false);
    expect(cleared({ all: [] }, bound, openedOnly)).toBe(true);
  });
});

describe("what a rule consults", () => {
  const bound: ActivityBindings = {
    conversation: [{ key: "thread:t", ordinals: { opened: 0 } }],
    placement: [{ key: "channel:a", ordinals: { placement: 1 } }],
  };

  it("names every subject the rule's roles bind, and only those", () => {
    expect(consultedSubjects(ACTIVITY_CLEAR_RULES.thread_started, bound)).toEqual(["thread:t", "channel:a"]);
    expect(consultedSubjects(ACTIVITY_CLEAR_RULES.mentioned, bound)).toEqual(["thread:t"]);
  });

  it("says which rules read the placement role", () => {
    expect(readsRole(ACTIVITY_CLEAR_RULES.thread_started, "placement")).toBe(true);
    expect(readsRole(ACTIVITY_CLEAR_RULES.run_finished, "placement")).toBe(false);
  });
});
