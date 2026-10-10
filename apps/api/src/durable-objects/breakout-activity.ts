import type { ConversationEffect } from "@rally/contracts/conversation-effects";

type ActivityEventEffect = Extract<ConversationEffect, { kind: "activity_event" }>;

/**
 * A breakout's mentions, as the Activity tab reads them.
 *
 * A breakout is private to the people in it, so its activity events stay out
 * of the Organization's shared log: digests and every audience-checked reader
 * read that log by the parent thread's participants, who may not be the
 * breakout's. What a mentioned person needs is only that they were named,
 * which is a target edge. So the parent forwards a breakout's message event
 * only when it names somebody, and forwards it emptied: no text, out of the
 * digest, its targets the mentions alone. WorkspaceDO stores it with the
 * author as its audience and sends it nowhere further, and the Activity tab
 * still checks at read time that the viewer may list the breakout
 * (`workspace-activity-feed.ts`, `docs/digests.md`).
 */
export function breakoutMentionActivity(effect: ConversationEffect): ActivityEventEffect | null {
  if (effect.kind !== "activity_event" || effect.actorUserId === null) return null;
  const mentions = effect.targets.filter((target) => target.relation === "mentioned");
  if (mentions.length === 0) return null;
  return { ...effect, body: "", digestible: false, targets: mentions };
}

/** Whether an activity event is a breakout's, by the substream its producer stamped. */
export function isBreakoutActivityEvent(effect: ConversationEffect): boolean {
  if (effect.kind !== "activity_event") return false;
  const substreamId = effect.metadata.substreamId;
  return typeof substreamId === "string" && substreamId !== "0";
}
