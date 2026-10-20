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
 * rule    := { read: role, through: ordinal | ordinal[], since?: time }
 *          | { any: rule[] }          -- at least one holds
 *          | { all: rule[] }          -- every one holds
 * role    := "conversation"           -- the thread, or the breakout the row names
 *          | "placement"              -- each Channel the row's thread is placed in
 *          | "artifact"               -- the pinned artifact the row is about
 * ordinal := "opened"                 -- 0: the subject was opened at all
 *          | "message"                -- the row's own message
 *          | "placement"              -- the Channel placement that put the thread there
 *          | "version"                -- the artifact version the row is about
 * time    := "occurred"               -- when the row happened
 * ```
 *
 * `read` holds when **some** subject bound to the role has a waterline at or
 * above the ordinal. A list of ordinals is a fallback chain: the first one the
 * subject binds is the one compared, and a subject binding none of them never
 * satisfies the clause. With `since`, the subject must also have been read
 * at or after that time: a waterline remembers how far, and `since` asks
 * when, so a read from before the row happened cannot clear it. A role with
 * no subjects never satisfies a clause; an empty `any` is false and an empty
 * `all` is true, as in logic.
 *
 * A clause is meant to turn true and stay true: a waterline and its read time
 * only move forward, a bound ordinal does not move, and a subject once bound
 * stays bound. That is what keeps a cleared row cleared, and a new ordinal or
 * role has to keep it. The one exception is a thread placed in a Channel
 * again, whose placement takes a fresh ordinal
 * (`WorkspaceSpaceStorage.placementOrdinals`).
 */
export type ActivityRole = "conversation" | "placement" | "artifact";
export type ActivityOrdinal = "opened" | "message" | "placement" | "version";
export type ActivityTime = "occurred";

export type ActivityClearRule =
  | { read: ActivityRole; through: ActivityOrdinal | readonly ActivityOrdinal[]; since?: ActivityTime }
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

/** One row as its rule sees it: the subjects its roles bind, and its times. */
export interface ActivityRowFacts {
  roles: ActivityBindings;
  times: Record<ActivityTime, number>;
}

/** How far the person has read one subject, and when they last read it. */
export interface ActivityWaterline {
  through: number;
  at: number;
}

/**
 * What clears each kind of row.
 *
 * - **new_message** and **mentioned**: reading the conversation through the mentioning message.
 *   An event from before messages carried their ordinal binds no `message`,
 *   and falls back to an open.
 * - **added**: opening the conversation after being added. An open from
 *   before (an Organization-wide thread read before anyone added you, or an
 *   earlier membership) does not count.
 * - **breakout_started**: opening the breakout.
 * - **merged**: reading the merge, or failing that opening where it landed:
 *   the thread for a breakout's merge, the Channel for a thread's (whose
 *   waterline the merge's message took an ordinal on).
 * - **thread_started**: opening the thread, or reading a Channel it was
 *   placed in past that placement.
 * - **run_finished**: opening the conversation after the run finished, which
 *   is when the result is on screen. Its own ordinal is not kept by the
 *   directory, and comparing with the newest message instead let a later
 *   message make a cleared row unread again.
 * - **artifact_updated**: seeing the artifact at that version or later. Its
 *   pin's unread state reads the same waterline.
 */
export const ACTIVITY_CLEAR_RULES: Readonly<Record<ActivityItemKind, ActivityClearRule>> = {
  new_message: { read: "conversation", through: ["message", "opened"] },
  mentioned: { read: "conversation", through: ["message", "opened"] },
  added: { read: "conversation", through: "opened", since: "occurred" },
  breakout_started: { read: "conversation", through: "opened" },
  thread_started: {
    any: [
      { read: "conversation", through: "opened" },
      { read: "placement", through: "placement" },
    ],
  },
  run_finished: { read: "conversation", through: "opened", since: "occurred" },
  merged: { read: "conversation", through: ["message", "opened"] },
  artifact_updated: { read: "artifact", through: "version" },
};

/** Whether a rule reads a role anywhere in it: what decides whether that role is worth binding. */
export function readsRole(rule: ActivityClearRule, role: ActivityRole): boolean {
  if ("read" in rule) return rule.read === role;
  return ("any" in rule ? rule.any : rule.all).some((child) => readsRole(child, role));
}

/** Every subject key a rule could consult for these bindings: what to load before {@link cleared}. */
export function consultedSubjects(rule: ActivityClearRule, roles: ActivityBindings): string[] {
  if ("read" in rule) return (roles[rule.read] ?? []).map((subject) => subject.key);
  return ("any" in rule ? rule.any : rule.all).flatMap((child) => consultedSubjects(child, roles));
}

/**
 * Whether a rule holds for one row. `waterlines` is the person's waterline per
 * subject key; a subject with none has read nothing, not even an open.
 */
export function cleared(
  rule: ActivityClearRule,
  row: ActivityRowFacts,
  waterlines: ReadonlyMap<string, ActivityWaterline>,
): boolean {
  if ("any" in rule) return rule.any.some((child) => cleared(child, row, waterlines));
  if ("all" in rule) return rule.all.every((child) => cleared(child, row, waterlines));
  const chain = typeof rule.through === "string" ? [rule.through] : rule.through;
  const since = rule.since === undefined ? undefined : row.times[rule.since];
  return (row.roles[rule.read] ?? []).some((subject) => {
    const waterline = waterlines.get(subject.key);
    if (waterline === undefined) return false;
    if (since !== undefined && waterline.at < since) return false;
    const ordinal = chain.map((name) => subject.ordinals[name]).find((value) => value !== undefined);
    return ordinal !== undefined && waterline.through >= ordinal;
  });
}
