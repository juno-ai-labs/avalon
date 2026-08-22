import { IdSchema, TimestampSchema, WorkspaceIdSchema } from "@avalon/contracts";
import { z } from "zod";

import type { Env } from "../env";
import { logWarn } from "../observability/logger";

/**
 * The one way a person's open sockets are closed.
 *
 * Every socket in Avalon is authorized when it connects and then holds until
 * something closes it. Nothing an object can see tells it that a session was
 * revoked or a membership ended — those facts live in D1, with the Worker that
 * wrote them. So the writer publishes here, and the consumer walks the object
 * hierarchy telling each holder to drop what it has.
 *
 * No object polls, revalidates on a timer, or re-authorizes while publishing.
 * If a retraction is not on this queue it does not reach an open socket, which
 * makes the producer side a rule rather than a convenience: **whoever writes
 * the fact publishes the message, in the same request that wrote it.**
 * See `docs/access-revocation.md`.
 *
 * The walk is queue-driven rather than one long call chain. A message names one
 * object; that object closes its own sockets and answers with the children it
 * knows about, because only it knows them; the consumer turns each of those
 * into its own message. Each hop is therefore retried on its own, no invocation
 * holds the whole hierarchy open, and no object needs to know that a queue is
 * what carries the revocation.
 */
const RevocationTargetSchema = z.discriminatedUnion("scope", [
  /** Published by whoever wrote the retraction. Every other scope descends from it. */
  z.object({ scope: z.literal("workspace") }).strict(),
  z.object({ scope: z.literal("workstream"), workstreamId: IdSchema }).strict(),
  z.object({
    scope: z.literal("substream"),
    workstreamId: IdSchema,
    substreamId: z.union([z.literal("0"), IdSchema]),
  }).strict(),
  z.object({ scope: z.literal("block"), workstreamId: IdSchema, blockId: IdSchema }).strict(),
]);

export const AccessRevocationMessageSchema = z.object({
  kind: z.literal("access_revoked"),
  /** Why access ended. Carried for operators; the fan-out treats all alike. */
  reason: z.enum([
    "workspace_membership_removed",
    "session_revoked",
    "session_expired",
  ]),
  workspaceId: WorkspaceIdSchema,
  userId: IdSchema,
  /**
   * The one session that ended, when only one did.
   *
   * A revoked session must not close the person's other windows, so a socket is
   * dropped only when it presented this session. Absent means every session:
   * the membership is gone, so nothing they hold is still admissible.
   */
  sessionId: z.string().min(1).max(200).nullable(),
  target: RevocationTargetSchema,
  occurredAt: TimestampSchema,
}).strict();

export type AccessRevocationMessage = z.infer<typeof AccessRevocationMessageSchema>;
export type RevocationTarget = z.infer<typeof RevocationTargetSchema>;

/**
 * What an object is told: who lost access, and which of their sockets to drop.
 *
 * Deliberately not the whole message. An object closes sockets and names its
 * children; it has no use for the target that addressed it, and no business
 * deciding whether the retraction was legitimate.
 */
export const SocketAccessRevocationSchema = AccessRevocationMessageSchema.pick({
  reason: true,
  workspaceId: true,
  userId: true,
  sessionId: true,
}).strict();

export type SocketAccessRevocation = z.infer<typeof SocketAccessRevocationSchema>;

/** The message an object publishes to carry its own revocation to one child. */
export function descendantRevocation(
  revocation: SocketAccessRevocation,
  target: RevocationTarget,
): AccessRevocationMessage {
  return AccessRevocationMessageSchema.parse({
    kind: "access_revoked",
    ...revocation,
    target,
    occurredAt: new Date().toISOString(),
  });
}

/**
 * Publish one retraction, from the code that made it true.
 *
 * Deliberately not fatal to its caller: a member removal that committed in D1
 * has removed the member whether or not the socket fan-out was enqueued, and
 * failing the request would tell the operator the opposite. The message is the
 * only path to an open socket, so a failure here is logged loudly and the
 * connection outlives the removal until it reconnects and fails admission.
 */
export async function publishAccessRevocation(
  env: Env,
  message: Omit<AccessRevocationMessage, "kind" | "occurredAt" | "target"> & { occurredAt?: string },
): Promise<void> {
  const parsed = AccessRevocationMessageSchema.parse({
    kind: "access_revoked",
    occurredAt: new Date().toISOString(),
    target: { scope: "workspace" },
    ...message,
  });
  try {
    await env.ACCESS_REVOCATION_QUEUE.send(parsed);
  } catch (error) {
    logWarn(env, "access_revocation_publish_failed", {
      workspace_id: parsed.workspaceId,
      user_id: parsed.userId,
      session_id: parsed.sessionId,
      reason: parsed.reason,
      error: error instanceof Error ? error.message : "unknown",
    });
  }
}

/**
 * Whether a queue batch belongs to this protocol.
 *
 * Matched on the whole suffix rather than anywhere in the name: every region
 * names its queue `avalon-<region>-access-revocations`, and the dead-letter
 * queue beside it is `…-access-revocations-dead-letter`. A substring test would
 * route a dead-lettered batch back into the consumer that already failed it,
 * which is the one delivery that must not be retried here.
 */
export function isAccessRevocationQueue(queue: string): boolean {
  return queue.endsWith("-access-revocations");
}

/** Cloudflare accepts at most 100 messages in one `sendBatch`. */
const QUEUE_SEND_BATCH = 100;

/**
 * Publish an object's descendants, from inside that object.
 *
 * Failure is not swallowed here, unlike the producer above: the caller is
 * handling a queue message, so throwing retries the hop that would otherwise
 * leave a child unvisited.
 */
export async function publishDescendantRevocations(
  env: Env,
  messages: readonly AccessRevocationMessage[],
): Promise<void> {
  for (let index = 0; index < messages.length; index += QUEUE_SEND_BATCH) {
    await env.ACCESS_REVOCATION_QUEUE.sendBatch(
      messages.slice(index, index + QUEUE_SEND_BATCH).map((body) => ({ body })),
    );
  }
}

/** A session row as the statements that end one return it. */
export interface RevokedSessionRow {
  id: string;
  user_id: string;
  workspace_id: string | null;
}

/**
 * Announce sessions that just ended.
 *
 * A session with no workspace never held a workspace socket, so there is
 * nothing to close and nothing to publish for it.
 */
export async function publishSessionRevocations(
  env: Env,
  sessions: readonly RevokedSessionRow[],
  reason: AccessRevocationMessage["reason"],
): Promise<void> {
  await Promise.all(sessions.map(async (session) => {
    if (!session.workspace_id) return;
    await publishAccessRevocation(env, {
      reason,
      workspaceId: WorkspaceIdSchema.parse(session.workspace_id),
      userId: IdSchema.parse(session.user_id),
      sessionId: session.id,
    });
  }));
}

/**
 * End the sessions whose time ran out, and close what they are holding.
 *
 * Expiry is the one retraction nobody performs: a session simply stops being
 * valid, so no request writes it and no message would ever be published. This
 * sweep is that writer. Marking the row revoked as it goes is what makes it
 * exactly-once — an expired session is revoked by any reading of the word, and
 * a row already marked is not returned to the next run.
 *
 * Bounded per run because it is one statement on a five-minute cron: a backlog
 * drains over several runs rather than turning one invocation into a migration.
 */
export async function reapExpiredSessions(env: Env, limit = 200): Promise<number> {
  const result = await env.DB.prepare(
    `UPDATE sessions SET revoked_at = ?
      WHERE id IN (
        SELECT id FROM sessions
         WHERE revoked_at IS NULL AND expires_at <= ?
         ORDER BY expires_at LIMIT ?
      )
      RETURNING id, user_id, workspace_id`,
  ).bind(new Date().toISOString(), new Date().toISOString(), limit)
    .all<RevokedSessionRow>();
  const expired = result.results ?? [];
  await publishSessionRevocations(env, expired, "session_expired");
  return expired.length;
}
