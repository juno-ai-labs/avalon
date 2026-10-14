import {
  DEFAULT_PUSH_PREFERENCES,
  IdSchema,
  MemberPreferencesUpdateSchema,
  PushPreferencesSchema,
  WorkspaceIdSchema,
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

/**
 * Whether this person's switches let a push of this kind through. The facts
 * are asked only when a narrower switch is off, so the common case reads
 * nothing past the switches themselves.
 */
export function pushPreferenceAllows(
  preferences: PushPreferences,
  kind: PushNotificationData["kind"],
  facts: { inMyChannel: () => boolean; startedByMe: () => boolean },
): boolean {
  switch (kind) {
    case "mention": return preferences.mentions;
    case "participant_added": return preferences.added;
    case "thread_started":
      return preferences.newThreads && (preferences.newThreadsOutsideMyChannels || facts.inMyChannel());
    case "breakout_started": return preferences.newBreakouts;
    case "run_finished":
      return preferences.runFinished && (preferences.runFinishedOthers || facts.startedByMe());
  }
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

export const PushPreferenceCheckRequestSchema = MemberPreferencesReadRequestSchema.extend({
  kind: PushNotificationDataSchema.shape.kind,
  threadId: IdSchema,
  substreamId: z.string().min(1).nullable(),
}).strict();
export type PushPreferenceCheckRequest = z.infer<typeof PushPreferenceCheckRequestSchema>;
