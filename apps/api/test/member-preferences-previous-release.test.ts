/**
 * The preferences record must keep parsing under the previous release's
 * schema for one release: an older desktop requires `notify.newThreads` and
 * `notify.newBreakouts`. The schema below is that release's, copied verbatim
 * from d0cab03's packages/contracts/src/index.ts, so a change here cannot
 * move it.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AutomationDeliveryTargetTypeSchema } from "@rally/contracts";

import { storedMemberPreferences } from "../src/durable-objects/member-preferences";

// --- d0cab03, verbatim ---
export const PushPreferencesSchema = z.object({
  mentions: z.boolean(),
  added: z.boolean(),
  newThreads: z.boolean(),
  newThreadsOutsideMyChannels: z.boolean(),
  newBreakouts: z.boolean(),
  runFinished: z.boolean(),
  runFinishedOthers: z.boolean(),
});
export type PushPreferences = z.infer<typeof PushPreferencesSchema>;
export const DEFAULT_PUSH_PREFERENCES: PushPreferences = {
  mentions: true,
  added: true,
  newThreads: true,
  newThreadsOutsideMyChannels: true,
  newBreakouts: true,
  runFinished: true,
  runFinishedOthers: true,
};
/**
 * Where one notification can reach a person: a push to their devices, an
 * email, or any surface a connector declares for delivering to a person
 * (`userDelivery`). A new connector surface joins through
 * `AutomationDeliveryTargetTypeSchema` and needs no change here.
 */
export const NotificationChannelSchema = z.union([z.literal("push"), AutomationDeliveryTargetTypeSchema]);
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;
/** The kinds of Activity row a person chooses channels for, one per row in Settings. */
export const NotificationKindSchema = z.enum(["mentions", "newMessages", "added", "newThreads", "newBreakouts", "runFinished", "merges", "artifactUpdates"]);
export type NotificationKind = z.infer<typeof NotificationKindSchema>;
/**
 * Lenient on read: a channel this build does not know (a newer server's, or
 * one a rollback left stored) is dropped rather than failing the whole record.
 */
const NotificationChannelListSchema = z.array(z.string()).transform((channels) => [...new Set(channels.flatMap((channel) => {
  const known = NotificationChannelSchema.safeParse(channel);
  return known.success ? [known.data] : [];
}))]);
/**
 * How each kind reaches this person. An empty list means it is only in
 * Activity and the daily digest.
 */
export const NotificationChannelsSchema = z.object({
  mentions: NotificationChannelListSchema,
  newMessages: NotificationChannelListSchema.default(["push"]),
  added: NotificationChannelListSchema,
  newThreads: NotificationChannelListSchema,
  newBreakouts: NotificationChannelListSchema,
  runFinished: NotificationChannelListSchema,
  /** Defaulted: a server older than merges does not send it. */
  merges: NotificationChannelListSchema.default(["push"]),
  /** Defaulted: a server older than artifact pins does not send it. */
  artifactUpdates: NotificationChannelListSchema.default(["push"]),
});
export type NotificationChannels = z.infer<typeof NotificationChannelsSchema>;
/**
 * Some kinds' channels, as a save names them or a row stores them. The
 * defaults are unwrapped: a partial field still fills in its default, so a
 * save of one kind would otherwise reset every defaulted kind it left out.
 */
export const NotificationChannelsChoiceSchema = NotificationChannelsSchema
  .extend({
    newMessages: NotificationChannelsSchema.shape.newMessages.unwrap(),
    merges: NotificationChannelsSchema.shape.merges.unwrap(),
    artifactUpdates: NotificationChannelsSchema.shape.artifactUpdates.unwrap(),
  })
  .partial();
export const DEFAULT_NOTIFICATION_CHANNELS: NotificationChannels = {
  mentions: ["push", "slack_agent_dm"],
  newMessages: ["push"],
  added: ["push", "slack_agent_dm"],
  newThreads: ["push"],
  newBreakouts: ["push"],
  runFinished: ["push"],
  merges: ["push"],
  artifactUpdates: ["push"],
};
export const MemberPreferencesSchema = z.object({
  /** Whether the transcript shows the agent's work: its thinking and its tool and plugin calls. */
  showAgentWork: z.boolean(),
  /**
   * What a client older than `notify` reads: each kind's switch is whether
   * `notify` lists `push` for it. Absent from a server older than it: read as
   * every default.
   */
  push: PushPreferencesSchema.default(DEFAULT_PUSH_PREFERENCES),
  /** Absent from a server older than it: read as every default. */
  notify: NotificationChannelsSchema.default(DEFAULT_NOTIFICATION_CHANNELS),
});
export type MemberPreferences = z.infer<typeof MemberPreferencesSchema>;

// --- end d0cab03 ---

const row = (notify: Record<string, unknown>, push: Record<string, unknown> = {}) => ({
  show_agent_work: 1, push_json: JSON.stringify(push), notify_json: JSON.stringify(notify),
});

describe("the preferences record under the previous release's schema", () => {
  it("parses for a person with nothing set, one who set the Thread-era kinds, and one whose old switch turned one off", () => {
    for (const stored of [row({}), row({ newThreads: ["email"], newBreakouts: [], accessRequests: [] }), row({}, { newBreakouts: false })]) {
      const record = storedMemberPreferences(stored);
      expect(MemberPreferencesSchema.safeParse(JSON.parse(JSON.stringify(record))).success).toBe(true);
    }
    expect(storedMemberPreferences(row({ newThreads: ["email"] })).notify).toMatchObject({ newThreads: ["email"], newBreakouts: ["push"] });
    expect(storedMemberPreferences(row({}, { newBreakouts: false })).notify.newBreakouts).toEqual([]);
  });
});
