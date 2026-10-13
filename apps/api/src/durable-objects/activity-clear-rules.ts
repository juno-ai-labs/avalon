import type { ActivityItemKind } from "@rally/contracts";

/**
 * The rule language that says what clears an Activity row.
 *
 * A row is cleared by what the person did, and what they did arrives as
 * events that move a waterline per subject (`workspace_activity_reads`; see
 * `workspace-activity-feed.ts`). A rule names which of the row's subjects to
 * look at and which of that subject's ordinals the waterline has to reach. It
 * is plain data, so a new row kind is one line in {@link ACTIVITY_CLEAR_RULES}
 * and a new way to clear one is a new binding, never a new branch here.
 *
 * Grammar:
 *
 * ```
 * rule    := { read: role, through: ordinal | ordinal[] }
 *          | { any: rule[] }          -- at least one holds
 *          | { all: rule[] }          -- every one holds
 * role    := "conversation"           -- the thread, or the breakout the row names
 *          | "placement"              -- each Channel the row's thread is placed in
 * ordinal := "opened"                 -- 0: the subject was opened at all
 *          | "message"                -- the row's own message
 *          | "latest"                 -- the conversation's newest message
 *          | "placement"              -- the Channel placement that put the thread there
 * ```
 *
 * `read` holds when **some** subject bound to the role has a waterline at or
 * above the ordinal. A list of ordinals is a fallback chain: the first one the
 * subject binds is the one compared, and a subject binding none of them never
 * satisfies the clause. A role with no subjects never satisfies a clause; an
 * empty `any` is false and an empty `all` is true, as in logic.
 */
export type ActivityRole = "conversation" | "placement";
export type ActivityOrdinal = "opened" | "message" | "latest" | "placement";

export type ActivityClearRule =
  | { read: ActivityRole; through: ActivityOrdinal | readonly ActivityOrdinal[] }
  | { any: readonly ActivityClearRule[] }
  | { all: readonly ActivityClearRule[] };

/** One subject a row is bound to, with the ordinals it knows. */
export interface ActivitySubjectBinding {
  /** The subject's waterline key (`activitySubjectKey`). */
  key: string;
  ordinals: Partial<Record<ActivityOrdinal, number>>;
}

/** What one row binds each role to. A role it does not bind has no subjects. */
export type ActivityBindings = Partial<Record<ActivityRole, readonly ActivitySubjectBinding[]>>;

/**
 * What clears each kind of row.
 *
 * - **mentioned**: reading the conversation through the mentioning message.
 *   An event from before messages carried their ordinal binds no `message`,
 *   and falls back to an open.
 * - **added**, **breakout_started**: opening the conversation. Being added
 *   leaves the newest message unread, so opening is reading to where you were
 *   put; a start is the conversation itself.
 * - **thread_started**: opening the thread, or reading a Channel it sits in
 *   past the placement that put it there.
 * - **run_finished**: reading to the conversation's newest message. The
 *   directory keeps no ordinal for the finish itself, so a later message
 *   raises the bar until it is read too.
 */
export const ACTIVITY_CLEAR_RULES: Readonly<Record<ActivityItemKind, ActivityClearRule>> = {
  mentioned: { read: "conversation", through: ["message", "opened"] },
  added: { read: "conversation", through: "opened" },
  breakout_started: { read: "conversation", through: "opened" },
  thread_started: {
    any: [
      { read: "conversation", through: "opened" },
      { read: "placement", through: "placement" },
    ],
  },
  run_finished: { read: "conversation", through: "latest" },
};

/** Whether a rule reads a role anywhere in it: what decides whether that role is worth binding. */
export function readsRole(rule: ActivityClearRule, role: ActivityRole): boolean {
  if ("read" in rule) return rule.read === role;
  return ("any" in rule ? rule.any : rule.all).some((child) => readsRole(child, role));
}

/** Every subject key a rule could consult for these bindings: what to load before {@link cleared}. */
export function consultedSubjects(rule: ActivityClearRule, bindings: ActivityBindings): string[] {
  if ("read" in rule) return (bindings[rule.read] ?? []).map((subject) => subject.key);
  return ("any" in rule ? rule.any : rule.all).flatMap((child) => consultedSubjects(child, bindings));
}

/**
 * Whether a rule holds for one row. `waterlines` is the person's waterline per
 * subject key; a subject with none has read nothing, not even an open.
 */
export function cleared(
  rule: ActivityClearRule,
  bindings: ActivityBindings,
  waterlines: ReadonlyMap<string, number>,
): boolean {
  if ("any" in rule) return rule.any.some((child) => cleared(child, bindings, waterlines));
  if ("all" in rule) return rule.all.every((child) => cleared(child, bindings, waterlines));
  const chain = typeof rule.through === "string" ? [rule.through] : rule.through;
  return (bindings[rule.read] ?? []).some((subject) => {
    const waterline = waterlines.get(subject.key);
    if (waterline === undefined) return false;
    const ordinal = chain.map((name) => subject.ordinals[name]).find((value) => value !== undefined);
    return ordinal !== undefined && waterline >= ordinal;
  });
}
