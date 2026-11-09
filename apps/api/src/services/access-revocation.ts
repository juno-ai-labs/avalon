import { IdSchema, TimestampSchema, WorkspaceIdSchema } from "@rally/contracts";
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
 * makes the producer side a rule rather than a convenience. Membership writes
 * now additionally record a transactional D1 intent; the scheduled dispatcher
 * retries publication after a request/Queue failure. Other producers still
 * publish in the request that wrote the fact.
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
  z.strictObject({ scope: z.literal("workspace") }),
  z.strictObject({ scope: z.literal("workstream"), workstreamId: IdSchema }),
  z.strictObject({
    scope: z.literal("substream"),
    workstreamId: IdSchema,
    substreamId: z.union([z.literal("0"), IdSchema]),
  }),
  z.strictObject({ scope: z.literal("automation"), automationId: IdSchema }),
  /**
   * A Space, for a person who just lost the Organization.
   *
   * It holds no sockets of its own — its role refuses a client upgrade — so
   * this hop exists only to name its children. That is the whole reason it is
   * a hop rather than nothing: the Space's hidden main conversation is an
   * ordinary `AgentLoopDO`, it *does* hold whatever was opened against it,
   * and only the Space knows which conversations it has.
   */
  z.strictObject({ scope: z.literal("space"), spaceId: IdSchema }),
  /**
   * Every automation a work stream owns, for a person who just lost that
   * room. A room-owned automation admits the room's participants to its
   * conversation and its runs, and removing a participant is a room-local
   * write that no membership revocation follows, so the room's writer
   * publishes this and WorkspaceDO names the automations.
   */
  z.strictObject({ scope: z.literal("workstream_automations"), workstreamId: IdSchema }),
  /**
   * A work stream that stopped admitting the whole Organization.
   *
   * The one target that names nobody, because a narrowing does not know who
   * it took access from: the readers it drops are every member who was not a
   * participant, and that set is the Organization. What *is* enumerable is who
   * still has a socket open, and only the room can answer that — so this hop
   * asks it to close the ones it can no longer admit and to say whose they
   * were. Each of those names then becomes an ordinary per-user hop, which is
   * what reaches the substreams and the automations the room owns.
   *
   * It is therefore the only target carried with `userId: null`, and the
   * schema below refuses the two in any other combination: a per-user hop
   * that lost its user would close every socket it found.
   */
  z.strictObject({ scope: z.literal("workstream_audience_narrowed"), workstreamId: IdSchema }),
  /**
   * A live web artifact's supervisor, a sibling of the work streams.
   *
   * It hangs off the workspace hop rather than a work stream's because
   * `artifact_registry` lives in WorkspaceDO beside the resource authority,
   * and only the object that holds a list can name its children. It is a leaf:
   * an artifact has no children of its own.
   *
   * What it drops is viewer sessions rather than sockets — an artifact holds
   * none — but the reason it is on this queue is the same as everything else
   * here: a session that outlived a membership is a page still serving to
   * somebody who is no longer in the workspace, and nothing the object can see
   * would tell it that.
   */
  z.strictObject({ scope: z.literal("artifact"), artifactId: IdSchema }),
]);

const AccessRevocationMessageShape = z.strictObject({
  kind: z.literal("access_revoked"),
  /** Why access ended. Carried for operators; the fan-out treats all alike. */
  reason: z.enum([
    "workspace_membership_removed",
    "workstream_participant_removed",
    "session_revoked",
    "session_expired",
  ]),
  workspaceId: WorkspaceIdSchema,
  /**
   * Whose access ended. Null only for `workstream_audience_narrowed`, which
   * cannot name one — see that target.
   */
  userId: IdSchema.nullable(),
  /**
   * The one session that ended, when only one did.
   *
   * A revoked session must not close the person's other windows, so a socket is
   * dropped only when it presented this session. Absent means every session:
   * the membership is gone, so nothing they hold is still admissible.
   */
  sessionId: z.string().min(1).max(200).nullable(),
  membershipIncarnation: z.string().min(1).optional(),
  target: RevocationTargetSchema,
  occurredAt: TimestampSchema,
});

/**
 * A message is either about one person or about one room's whole audience,
 * never half of each. The refinement names the field rather than failing the
 * message as a whole (`docs/naming-a-schema-failure.md`): the consumer logs
 * `parsed.error.issues` by path, and "userId" is what an operator needs to see.
 */
export const AccessRevocationMessageSchema = AccessRevocationMessageShape.superRefine((message, context) => {
  const audienceNarrowed = message.target.scope === "workstream_audience_narrowed";
  if (audienceNarrowed === (message.userId === null)) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["userId"],
    message: audienceNarrowed
      ? "a narrowed audience names no user"
      : "this target requires the user whose access ended",
  });
});

export type AccessRevocationMessage = z.infer<typeof AccessRevocationMessageSchema>;
export type RevocationTarget = z.infer<typeof RevocationTargetSchema>;

/**
 * What an object is told: who lost access, and which of their sockets to drop.
 *
 * Deliberately not the whole message. An object closes sockets and names its
 * children; it has no use for the target that addressed it, and no business
 * deciding whether the retraction was legitimate.
 */
export const SocketAccessRevocationSchema = AccessRevocationMessageShape.pick({
  reason: true,
  workspaceId: true,
  sessionId: true,
  membershipIncarnation: true,
  // Restored to non-null here rather than inherited: an object is only ever
  // told about one person, and the one target that names nobody never reaches
  // `revokeSocketAccess` — it is answered by a method that decides for itself.
}).extend({ userId: IdSchema }).strict();

export type SocketAccessRevocation = z.infer<typeof SocketAccessRevocationSchema>;

/**
 * Whether one socket belongs to the revocation being applied.
 *
 * Single-sourced because the four socket roles disagree about their own
 * attachments and a divergence here is silent: `AgentLoopDO` alone makes
 * `sessionId` optional — a socket accepted before the command gateway carries
 * none — while the other three require it. Written inline, the natural
 * `attachment.sessionId !== request.sessionId` reads as "skip" for `undefined`,
 * which exempted exactly the transcript feed from every logout and expiry.
 *
 * The rule: a socket is this person's, and either the revocation names no
 * session (the membership is gone, so nothing they hold is admissible) or the
 * socket cannot be shown *not* to be the named session. An unknown session is
 * closed rather than spared — that costs a reconnect, where sparing it keeps a
 * dead session reading.
 */
export function revocationClosesSocket(
  revocation: SocketAccessRevocation,
  attachment: { userId: string; sessionId?: string | undefined },
): boolean {
  if (attachment.userId !== revocation.userId) return false;
  if (revocation.sessionId === null) return true;
  return attachment.sessionId === undefined || attachment.sessionId === revocation.sessionId;
}

/** Membership delivery may arrive after rejoin. Resolve the immutable session
 * binding at each holder, including legacy attachments, rather than consulting
 * the user's current membership or trusting a root-only check. Missing session
 * evidence fails closed; a D1 failure retries the queue hop. */
export async function revocationClosesSession(
  env: Pick<Env, "DB">,
  revocation: SocketAccessRevocation,
  attachment: { userId: string; sessionId?: string | undefined },
): Promise<boolean> {
  if (!revocationClosesSocket(revocation, attachment)) return false;
  if (!revocation.membershipIncarnation || !attachment.sessionId) return true;
  const session = await env.DB.prepare(`SELECT workspace_incarnation FROM sessions
    WHERE id = ? AND user_id = ? AND workspace_id = ?`)
    .bind(attachment.sessionId, revocation.userId, revocation.workspaceId)
    .first<{ workspace_incarnation: string | null }>();
  return !session?.workspace_incarnation || session.workspace_incarnation === revocation.membershipIncarnation;
}

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
 * connection can outlive the removal until the durable membership retry reaches
 * it, or it reconnects and fails admission. Other producers retain their own
 * retry contracts (session expiry retries, logout currently does not).
 *
 * Returns whether the message went out, so a caller that can still retry — the
 * expiry sweep — does not record a retraction as delivered when it was not. A
 * caller whose request is already returning may ignore it.
 */
export async function publishAccessRevocation(
  env: Env,
  message: Omit<AccessRevocationMessage, "kind" | "occurredAt" | "target">
    & { occurredAt?: string; target?: AccessRevocationMessage["target"] },
): Promise<boolean> {
  // The parse is inside the try, not before it. It is practically unreachable —
  // every field is a UUID this Worker just read out of D1 — but the invariant
  // above is absolute, and a schema failure thrown from here would escape into
  // a caller whose D1 write has already committed.
  try {
    const parsed = AccessRevocationMessageSchema.parse({
      kind: "access_revoked",
      occurredAt: new Date().toISOString(),
      target: { scope: "workspace" },
      ...message,
    });
    await env.ACCESS_REVOCATION_QUEUE.send(parsed);
    return true;
  } catch (error) {
    logWarn(env, "access_revocation_publish_failed", {
      workspace_id: message.workspaceId,
      user_id: message.userId,
      session_id: message.sessionId,
      reason: message.reason,
      error: error instanceof Error ? error.message : "unknown",
    });
    return false;
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

/** D1 binds at most 100 parameters per statement; two timestamps take two. */
const MARK_REVOKED_BATCH = 98;

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
 * Announce sessions that just ended, and report which announcements landed.
 *
 * A session with no workspace never held a workspace socket, so there is
 * nothing to close and nothing to publish for it; it counts as settled. The
 * returned list is what a caller may treat as delivered — see
 * {@link reapExpiredSessions}, which uses it to decide what to mark.
 */
export async function publishSessionRevocations(
  env: Env,
  sessions: readonly RevokedSessionRow[],
  reason: AccessRevocationMessage["reason"],
): Promise<RevokedSessionRow[]> {
  const announced = await Promise.all(sessions.map(async (session) => {
    if (!session.workspace_id) return session;
    // Parsed inside the same guard as the publish, for the reason
    // `publishAccessRevocation` states: nothing on this path may throw into a
    // caller whose D1 write has already committed.
    let published = false;
    try {
      published = await publishAccessRevocation(env, {
        reason,
        workspaceId: WorkspaceIdSchema.parse(session.workspace_id),
        userId: IdSchema.parse(session.user_id),
        sessionId: session.id,
      });
    } catch (error) {
      logWarn(env, "access_revocation_publish_failed", {
        workspace_id: session.workspace_id,
        user_id: session.user_id,
        session_id: session.id,
        reason,
        error: error instanceof Error ? error.message : "unknown",
      });
    }
    return published ? session : null;
  }));
  return announced.filter((session): session is RevokedSessionRow => session !== null);
}

/**
 * End the sessions whose time ran out, and close what they are holding.
 *
 * Expiry is the one retraction nobody performs: a session simply stops being
 * valid, so no request writes it and no message would ever be published. This
 * sweep is that writer.
 *
 * It publishes *before* it marks. Marking first would be tidier — one statement,
 * atomically exactly-once — but it makes a failed publish permanent: the row is
 * excluded from every later sweep, and since nothing else re-checks an open
 * socket, that person keeps receiving until they reconnect. Publishing first
 * costs at most a duplicate message when the mark fails, and a duplicate
 * revocation is a hop that finds nothing left to close. A lost one is a socket
 * nobody closes. The mark still stops a delivered expiry being re-announced on
 * every five-minute run, which is all it was ever for.
 *
 * Bounded per run because it is one statement on a five-minute cron: a backlog
 * drains over several runs rather than turning one invocation into a migration.
 */
export async function reapExpiredSessions(env: Env, limit = 200): Promise<number> {
  const now = new Date().toISOString();
  const expired = (await env.DB.prepare(
    `SELECT id, user_id, workspace_id FROM sessions
      WHERE revoked_at IS NULL AND expires_at <= ?
      ORDER BY expires_at LIMIT ?`,
  ).bind(now, limit).all<RevokedSessionRow>()).results ?? [];
  if (expired.length === 0) return 0;

  const announced = await publishSessionRevocations(env, expired, "session_expired");
  if (announced.length === 0) return 0;
  // Only what was announced is marked. A session whose message did not go out
  // stays unmarked and is picked up by the next run. Marked in batches because
  // D1 binds at most 100 parameters per statement and one of them is the
  // timestamp, so a full run of 200 does not fit in one.
  for (let index = 0; index < announced.length; index += MARK_REVOKED_BATCH) {
    const batch = announced.slice(index, index + MARK_REVOKED_BATCH);
    // The predicate is repeated, not just the ids. D1 auto-commits each
    // statement, so the rows were selected in an earlier round trip: a logout
    // landing in between has already written its own `revoked_at`, and marking
    // by id alone would overwrite that with this sweep's later timestamp,
    // moving the recorded moment access ended. `expires_at <= ?` is defensive —
    // nothing in this Worker moves that column after the insert, and refresh
    // rotates hashes while *requiring* `expires_at > ?` — but it costs one bound
    // parameter and makes the statement true on its own terms rather than on
    // that reading remaining true.
    await env.DB.prepare(
      `UPDATE sessions SET revoked_at = ?
        WHERE id IN (${batch.map(() => "?").join(",")})
          AND revoked_at IS NULL
          AND expires_at <= ?`,
    ).bind(now, ...batch.map((session) => session.id), now).run();
  }
  return announced.length;
}
