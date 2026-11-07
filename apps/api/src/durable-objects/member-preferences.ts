import {
  DEFAULT_MEMBER_PREFERENCES,
  DEFAULT_NOTIFICATION_CHANNELS,
  DEFAULT_PUSH_PREFERENCES,
  IdSchema,
  MemberPreferencesUpdateSchema,
  NotificationChannelSchema,
  NotificationChannelsChoiceSchema,
  NotificationKindSchema,
  PushPreferencesSchema,
  WorkspaceIdSchema,
  type MemberPreferences,
  type MemberPreferencesUpdate,
  type NotificationChannel,
  type NotificationChannels,
  type NotificationKind,
  type PushPreferences,
} from "@rally/contracts";
import { PushNotificationDataSchema, type PushNotificationData } from "@rally/contracts/push-notifications";
import { z } from "zod";

/**
 * A member's display preferences for one Organization, held by its WorkspaceDO.
 * One row per person; absent means every default. Delivered in the workspace
 * socket's connect payload so the first frame already honours them.
 */
export const WORKSPACE_MEMBER_PREFERENCES_MIGRATION: readonly string[] = [
  `CREATE TABLE member_preferences (
    user_id TEXT PRIMARY KEY,
    show_agent_work INTEGER NOT NULL CHECK (show_agent_work IN (0, 1)),
    updated_at INTEGER NOT NULL
  ) STRICT`,
];

/**
 * Migration 106: which push switches this person has set. Only the switches
 * they have touched are stored; everything else reads as its default, so a
 * switch added later starts on for everyone.
 */
export const WORKSPACE_MEMBER_PUSH_PREFERENCES_MIGRATION: readonly string[] = [
  `ALTER TABLE member_preferences
     ADD COLUMN push_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(push_json))`,
];

/**
 * Migration 107: how each kind reaches this person (`NotificationChannels`).
 * Only the kinds they have set are stored; a kind not named reads from the
 * push switch migration 106 may hold for it, then from the default.
 */
export const WORKSPACE_MEMBER_NOTIFY_PREFERENCES_MIGRATION: readonly string[] = [
  `ALTER TABLE member_preferences
     ADD COLUMN notify_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(notify_json))`,
];

/**
 * The push switch each kind of channel list mirrors for an older client. A
 * kind newer than the switches (`merges`) has none: an older client never
 * shows it, and its channels read from the default until the person sets them.
 */
const PUSH_SWITCH: Partial<Record<NotificationKind, keyof PushPreferences>> = {
  mentions: "mentions",
  added: "added",
  newThreads: "newThreads",
  newBreakouts: "newBreakouts",
  runFinished: "runFinished",
};
const KINDS = NotificationKindSchema.options;

/** The kind of channel list a pushed notification of this kind reads. */
export const NOTIFICATION_KIND_FOR_PUSH: Record<PushNotificationData["kind"], NotificationKind> = {
  mention: "mentions",
  new_message: "newMessages",
  participant_added: "added",
  thread_started: "newThreads",
  breakout_started: "newBreakouts",
  run_finished: "runFinished",
  merged: "merges",
  artifact_updated: "artifactUpdates",
  // A run waiting on input is the other half of "Sidekick runs" in Settings:
  // one choice covers both, rather than a second row for one notice.
  needs_input: "runFinished",
};

/** `changes` over `base`, switch by switch; a switch `changes` does not name keeps its value. */
export function mergePushPreferences(
  base: PushPreferences,
  changes: Partial<Record<keyof PushPreferences, boolean | undefined>> | undefined,
): PushPreferences {
  const merged = { ...base };
  for (const key of Object.keys(base) as Array<keyof PushPreferences>) {
    const value = changes?.[key];
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/** The stored switches over the defaults. */
export function storedPushPreferences(json: string | null | undefined): PushPreferences {
  return mergePushPreferences(DEFAULT_PUSH_PREFERENCES, PushPreferencesSchema.partial().parse(JSON.parse(json ?? "{}")));
}

/** The kinds a person has set; a kind they never touched is absent. */
type ChosenNotify = { [Kind in NotificationKind]?: NotificationChannel[] | undefined };

/**
 * The stored record's shape: every kind optional and none defaulted, so a
 * kind the person never set stays absent rather than reading as its default.
 */
const StoredNotifySchema = NotificationChannelsChoiceSchema;

/** The kinds this person has set, as stored. */
function storedNotify(json: string | null | undefined): ChosenNotify {
  return StoredNotifySchema.parse(JSON.parse(json ?? "{}"));
}

/** `channels` with `push` present or absent. */
function withPush(channels: readonly NotificationChannel[], push: boolean): NotificationChannel[] {
  const others = channels.filter((channel) => channel !== "push");
  return push ? ["push", ...others] : others;
}

/**
 * The whole record from its stored columns. A kind's channels are what the
 * person set, else the default with `push` removed if a push switch from
 * before channels existed turned it off. `push` mirrors the channels.
 */
export function storedMemberPreferences(row: {
  show_agent_work: number;
  push_json: string;
  notify_json: string;
} | undefined): MemberPreferences {
  if (!row) return { ...DEFAULT_MEMBER_PREFERENCES };
  const legacy = storedPushPreferences(row.push_json);
  const chosen = storedNotify(row.notify_json);
  const notify = Object.fromEntries(KINDS.map((kind) => {
    const legacySwitch = PUSH_SWITCH[kind];
    return [kind, chosen[kind] ?? (legacySwitch === undefined ? [...DEFAULT_NOTIFICATION_CHANNELS[kind]]
      : withPush(DEFAULT_NOTIFICATION_CHANNELS[kind], DEFAULT_NOTIFICATION_CHANNELS[kind].includes("push") && legacy[legacySwitch]))];
  })) as NotificationChannels;
  return { showAgentWork: row.show_agent_work === 1, push: mirroredPush(legacy, notify), notify };
}

/** The push switches an older client reads: each kind's from its channels. */
function mirroredPush(legacy: PushPreferences, notify: NotificationChannels): PushPreferences {
  const push = { ...legacy };
  for (const kind of KINDS) {
    const legacySwitch = PUSH_SWITCH[kind];
    if (legacySwitch !== undefined) push[legacySwitch] = notify[kind].includes("push");
  }
  return push;
}

/**
 * What a save stores. Each kind it names replaces that kind's channels; a
 * push switch from an older client adds or removes `push` on that kind. The
 * stored record names every kind the person has ever set, so a later change
 * to a default reaches only the kinds they never touched.
 */
export function savedNotify(
  row: { notify_json: string } | undefined,
  current: NotificationChannels,
  update: MemberPreferencesUpdate,
): ChosenNotify {
  const next: ChosenNotify = { ...storedNotify(row?.notify_json) };
  for (const kind of KINDS) {
    const legacySwitch = PUSH_SWITCH[kind];
    const switched = legacySwitch === undefined ? undefined : update.push?.[legacySwitch];
    if (switched !== undefined) next[kind] = withPush(next[kind] ?? current[kind], switched);
    const channels = update.notify?.[kind];
    if (channels !== undefined) next[kind] = channels;
  }
  return next;
}

/** Whether this person's choices send a notification of this kind on this channel. */
export function notificationAllows(
  notify: NotificationChannels,
  kind: PushNotificationData["kind"],
  channel: NotificationChannel,
): boolean {
  return notify[NOTIFICATION_KIND_FOR_PUSH[kind]].includes(channel);
}

export const MemberPreferencesReadRequestSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  userId: IdSchema,
});
export type MemberPreferencesReadRequest = z.infer<typeof MemberPreferencesReadRequestSchema>;

export const MemberPreferencesWriteRequestSchema = MemberPreferencesReadRequestSchema.extend({
  preferences: MemberPreferencesUpdateSchema,
});
export type MemberPreferencesWriteRequest = z.infer<typeof MemberPreferencesWriteRequestSchema>;

export const NotificationAllowsRequestSchema = MemberPreferencesReadRequestSchema.extend({
  kind: PushNotificationDataSchema.shape.kind,
  channel: NotificationChannelSchema,
}).strict();
export type NotificationAllowsRequest = z.infer<typeof NotificationAllowsRequestSchema>;
