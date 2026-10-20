import type { ConversationEffect } from "@rally/contracts/conversation-effects";

type ActivityEventEffect = Extract<ConversationEffect, { kind: "activity_event" }>;

/**
 * A breakout's mentions and human reply metadata, as Activity reads them.
 *
 * A breakout is private to the people in it, so its activity events stay out
 * of the Organization's shared log: digests and every audience-checked reader
 * read that log by the parent thread's participants, who may not be the
 * breakout's. What a mentioned person needs is only that they were named,
 * which is a target edge. So the parent forwards a breakout's message event
 * when it names somebody or has a human author, and forwards it emptied: no text, out of the
 * digest, its targets the mentions alone. WorkspaceDO stores it with the
 * author as its audience and sends it nowhere further, and the Activity tab
 * still checks at read time that the viewer may list the breakout
 * (`workspace-activity-feed.ts`, `docs/digests.md`).
 */
export function breakoutMessageActivity(
  effect: ConversationEffect,
  substreamId: string,
): ActivityEventEffect | null {
  if (effect.kind !== "activity_event" || effect.eventType !== "workstream_message_created" || effect.actorUserId === null) return null;
  const mentions = effect.targets.filter((target) => target.relation === "mentioned");
  if (mentions.length === 0 && effect.actorType !== "user") return null;
  // The breakout id is stamped here, by the parent that knows it, rather than
  // trusted from the producer: WorkspaceDO decides the audience by it, and an
  // effect a breakout wrote before producers stamped it would otherwise be
  // stored as the parent thread's.
  return {
    ...effect,
    body: "",
    digestible: false,
    targets: mentions,
    metadata: { ...effect.metadata, substreamId },
  };
}

/** Whether an activity event is a breakout's, by the substream its producer stamped. */
export function isBreakoutActivityEvent(effect: ActivityEventEffect): boolean {
  const substreamId = effect.metadata.substreamId;
  return typeof substreamId === "string" && substreamId !== "0";
}
