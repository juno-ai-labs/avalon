import { ConnectorParticipantAdmissionSchema } from "@rally/contracts/scope-grants";
import { workspaceDOName } from "../durable-objects/names";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { asWorkspaceId, type ExternalActor, type Scope } from "@rally/contracts";

import type { Env } from "../env";
import { logWarn } from "../observability/logger";
import { resolveConnectorActorIdentities } from "./connector-actor-identity";
import { createIdentityObjectPort } from "../runtime/identity-port";

/**
 * Who a work stream started from a connector conversation belongs to.
 *
 * The rule every agent connector follows, held here rather than in the Slack
 * service because it is not about Slack: **a work stream starts with the
 * audience of the conversation it came from.** A thread in a public channel
 * becomes a workspace-scoped work stream; one in a private channel or a direct
 * message becomes a personal-scoped work stream whose room is that
 * conversation's resolved members. Later speakers are admitted as they arrive.
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
 * The stored work-stream scope for a connector conversation's audience.
 *
 * `unknown` resolves to `personal`, which is the fail-closed direction: a
 * conversation Avalon could not classify is more likely to be one it could not
 * *see* than a public channel, and the cost of the two mistakes is not
 * symmetrical — a private work stream that should have been public is opened by
 * anyone in it with two clicks, while the reverse has already happened.
 *
 * **A conversation past `workspaceScopeThreshold` people is `workspace`
 * whatever its privacy says.** Below it, a private conversation is a room and
 * modelling it as one is what makes the work stream findable by exactly the
 * people who were in it. Above it, that stops being true in both directions: a
 * sixty-person channel is not a room anybody experiences as private, and the
 * participant list standing in for it is a large, stale copy of a membership
 * the provider already maintains. Widening the scope is the deliberate cost —
 * it makes the work stream readable by workspace members who are *not* in that
 * conversation, which the participant model would not have done — taken because
 * a work stream nobody can find is the worse failure at that size.
 *
 * The threshold has no default and every connector states its own: what counts
 * as "too many to be a room" is a fact about the provider's conversations, not
 * about Avalon, and a shared default would quietly become one connector's
 * number applied to everybody else's.
 *
 * Work streams retain the existing `personal`/`workspace` storage vocabulary.
 * For work streams, `personal` already means participant-only rather than
 * single-owner; the product continues to render those states as private/public.
 */
export function connectorWorkstreamScope(input: {
  audience: ConnectorConversationAudience;
  /** How many people the connector says the conversation holds. */
  memberCount: number;
  /** This connector's own answer to "too many to be a room". */
  workspaceScopeThreshold: number;
}): Scope {
  if (input.memberCount > input.workspaceScopeThreshold) return "workspace";
  return input.audience === "public" ? "workspace" : "personal";
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
): Promise<{ userIds: string[]; unresolved: number; unresolvedIndexes: number[] }> {
  let resolved: Array<string | null>;
  try {
    const identities = await resolveConnectorActorIdentities(
      env,
      workspaceId,
      members.map((member) => ({
        actor: member.actor,
        verifiedEmail: member.verifiedEmail ?? null,
      })),
    );
    resolved = identities.map((identity) => identity?.accessClass === "guest" ? null : identity?.userId ?? null);
  } catch (error) {
    // Audience discovery is best effort, but its query is deliberately one
    // operation: one D1 outage produces one bounded log rather than one per
    // conversation member.
    logWarn(env, "connector_audience_unresolved", {
      workspace_id: workspaceId,
      member_count: members.length,
      reason: error instanceof Error ? error.message : "unknown",
    });
    resolved = members.map(() => null);
  }
  const userIds = [...new Set(resolved.filter((id): id is string => id !== null))];
  const unresolvedIndexes = resolved.flatMap((id, index) => id === null ? [index] : []);
  return { userIds, unresolved: unresolvedIndexes.length, unresolvedIndexes };
}

/**
 * Put the people a connector conversation resolved to into the work stream.
 *
 * Migrated workstreams receipt each inbound event in the parent grant ledger;
 * retrying that event cannot undo a later removal. It is also what
 * makes a *private* connector work stream readable at all by the member who
 * just spoke in it — the ordinary read rule is "an active participant, and
 * nobody else", so a reply from somebody the room has never seen has to admit
 * them before the message can be written under their own authority.
 *
 * A new event may bring an ordinary member back after removal: they are
 * speaking in the source conversation. An old event cannot. Guests need an
 * explicit share and never acquire a new grant through connector mapping.
 * Unmigrated workstreams retain their legacy roster writer until handoff.
 */
export async function admitConnectorAudience(
  env: Env,
  input: {
    workspaceId: string;
    workstreamId: string;
    eventId: string;
    userIds: readonly string[];
    /** Who is credited with the addition; the arriving member, when it is theirs. */
    addedByUserId: string | null;
  },
): Promise<void> {
  const userIds = [...new Set(input.userIds)];
  if (userIds.length === 0) return;
  const parent = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, input.workspaceId,
    workspaceDOName(env.AVALON_REGION, asWorkspaceId(input.workspaceId)));
  const admission = await parent.admitConnectorParticipants(ConnectorParticipantAdmissionSchema.parse({
    workspaceId: input.workspaceId, parentId: input.workstreamId, eventId: input.eventId,
    userIds, addedByUserId: input.addedByUserId,
  }));
  if (admission.status !== "ready") throw new Error("connector_participant_admission_pending");
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

/** Attribution is local; admission follows whichever authority owns participants. */
export async function reconcileConnectorWorkstreamCreator(
  env: Env,
  input: {
    workspaceId: string;
    workstreamId: string;
    assignmentId: string;
    userId: string;
    previousAssignedUserId: string | null;
    mayCorrectVerifiedCreator: boolean;
  },
): Promise<void> {
  await createIdentityObjectPort(env, input.workspaceId, input.workstreamId).adoptCreator({
    userId: input.userId,
    previousAssignedUserId: input.previousAssignedUserId,
    mayCorrectVerifiedCreator: input.mayCorrectVerifiedCreator,
    now: Date.now(),
  });
  await admitConnectorAudience(env, { workspaceId: input.workspaceId, workstreamId: input.workstreamId,
      eventId: JSON.stringify(["connector-creator-adoption", input.assignmentId, input.userId]),
      userIds: [input.userId], addedByUserId: input.userId });
}
