import type { ExternalActor } from "@avalon/contracts";
import { buildParticipantUpsertStatement } from "@avalon/db";

import type { Env } from "../env";
import { logWarn } from "../observability/logger";
import { resolveConnectorActorIdentity } from "./connector-actor-identity";

/**
 * Who a work stream started from a connector conversation belongs to.
 *
 * The rule every agent connector follows, held here rather than in the Slack
 * service because it is not about Slack: **a work stream inherits the audience
 * of the conversation it was started from, and keeps inheriting it.** A thread
 * in a public channel becomes a public work stream; one in a private channel or
 * a direct message becomes a private work stream whose room is that
 * conversation's members. Anybody who can reach the conversation can therefore
 * reach the work stream, and nobody else can.
 *
 * This replaced a per-thread pin. A Slack thread used to be bound to the first
 * member who happened to be linked to Avalon, and every other person in the
 * channel — including the workspace owner — was refused with "this thread is
 * already running with another Avalon member's personal authority". The pin was
 * protecting something real (see {@link connectorMessagePrincipal}) but it
 * answered the wrong question: whose credentials a *run* spends is decided per
 * message, and does not need the conversation to have one owner.
 *
 * Two things are deliberately *not* symmetrical here:
 *
 * - **Membership is admitted, never revoked.** Somebody who leaves the Slack
 *   channel keeps the work stream they were in, the way they keep the messages
 *   they already read. Removing them is a membership decision a person makes.
 * - **A member Avalon cannot map is not an obstacle.** Their message is still
 *   recorded, under their external actor, because a work stream that silently
 *   drops what somebody said in the conversation it lives in is worse than one
 *   with a participant list shorter than the channel's.
 */

/** What a connector says about who could see the conversation it read from. */
export type ConnectorConversationAudience = "public" | "private" | "unknown";

/**
 * A person in the source conversation, as the connector sees them.
 *
 * `verifiedEmail` is the address the *provider* attests to for this identity —
 * Slack's `users.info` profile email — never one typed into a profile field
 * Avalon does not control. It is passed separately from the actor because it is
 * evidence for the mapping rather than part of the identity.
 */
export interface ConnectorConversationMember {
  actor: ExternalActor;
  verifiedEmail?: string | null;
}

/**
 * The work stream's visibility, given what the connector knows about the place.
 *
 * `unknown` resolves to `private`, which is the fail-closed direction: a
 * conversation Avalon could not classify is more likely to be one it could not
 * *see* than a public channel, and the cost of the two mistakes is not
 * symmetrical — a private work stream that should have been public is opened by
 * anyone in it with two clicks, while the reverse has already happened.
 */
export function connectorWorkstreamVisibility(
  audience: ConnectorConversationAudience,
): "public" | "private" {
  return audience === "public" ? "public" : "private";
}

/**
 * The Avalon members behind a conversation's people, for the ones that resolve.
 *
 * Runs the shared connector mapping — account link, that member's own personal
 * connection, then verified email — over every member the connector listed.
 * Identities that map to nobody are counted rather than guessed at: an
 * unresolved member is a person Avalon has no account for, and inventing one
 * would put a stranger in a private room.
 */
export async function resolveConnectorAudience(
  env: Env,
  workspaceId: string,
  members: readonly ConnectorConversationMember[],
): Promise<{ userIds: string[]; unresolved: number }> {
  const resolved = await Promise.all(members.map(async (member) => {
    try {
      const identity = await resolveConnectorActorIdentity(
        env,
        workspaceId,
        member.actor,
        member.verifiedEmail ?? null,
      );
      return identity?.userId ?? null;
    } catch (error) {
      // One unreadable member must not cost the work stream its whole room.
      logWarn(env, "connector_audience_member_unresolved", {
        workspace_id: workspaceId,
        provider: member.actor.provider,
        reason: error instanceof Error ? error.message : "unknown",
      });
      return null;
    }
  }));
  const userIds = [...new Set(resolved.filter((id): id is string => id !== null))];
  return { userIds, unresolved: resolved.length - userIds.length };
}

/**
 * Put the people a connector conversation resolved to into the work stream.
 *
 * Idempotent, and safe to call on every inbound message rather than only on the
 * first: the upsert lands on the row a participant already has. It is also what
 * makes a *private* connector work stream readable at all by the member who
 * just spoke in it — the ordinary read rule is "an active participant, and
 * nobody else", so a reply from somebody the room has never seen has to admit
 * them before the message can be written under their own authority.
 *
 * A member who was explicitly removed from the work stream is brought back by
 * the upsert. That is deliberate for the arrival path — they are speaking in
 * the conversation this work stream *is* — and it is why removal from a
 * connector-born work stream is a weaker statement than removal from one
 * somebody started in Avalon.
 */
export async function admitConnectorAudience(
  env: Env,
  input: {
    workspaceId: string;
    workstreamId: string;
    userIds: readonly string[];
    /** Who is credited with the addition; the arriving member, when it is theirs. */
    addedByUserId: string | null;
  },
): Promise<void> {
  const userIds = [...new Set(input.userIds)];
  if (userIds.length === 0) return;
  await env.DB.batch(userIds.map((userId) => buildParticipantUpsertStatement(env.DB, {
    workspaceId: input.workspaceId,
    workstreamId: input.workstreamId,
    userId,
    addedByUserId: input.addedByUserId ?? userId,
    reason: "explicit",
  })));
}

/**
 * Whose authority a message from a connector conversation runs under.
 *
 * The one place the old per-thread pin was right, kept and narrowed: a run
 * spends real credentials — that member's personal connectors, their memory,
 * approvals made in their name — so it may only run as somebody who has
 * *authenticated* to Avalon and bound their provider identity to it. That is an
 * account link, and nothing weaker. A verified-email match is enough to say who
 * somebody is for attribution and enough to seat them in the room; it is not
 * enough to spend their credentials, and the difference is the whole of
 * `docs/connectors.md`'s "attribution is not authorization".
 *
 * So each message is answered by whoever sent it: a linked member's message
 * runs as that member, and anybody else's runs under the workspace principal
 * with their external actor recorded as the author. Two consecutive messages in
 * one thread can therefore run under different principals, which is exactly
 * what happens in Avalon itself when two members type into the same work
 * stream.
 */
export function connectorMessagePrincipal(input: {
  workspaceId: string;
  /** The Avalon member this sender is *linked* to, not merely matched to. */
  linkedUserId: string | null;
}): { type: "user"; userId: string } | { type: "workspace"; workspaceId: string } {
  return input.linkedUserId
    ? { type: "user", userId: input.linkedUserId }
    : { type: "workspace", workspaceId: input.workspaceId };
}
