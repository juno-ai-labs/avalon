import { ConversationAccessRequestItemSchema, WorkstreamAppearanceSchema, type ConversationAccessRequestItem } from "@rally/contracts";
import type { z } from "zod";

/**
 * Requests by a member to join a Channel or Breakout, each addressed to one
 * approver (`docs/channel-access-requests.md`). At most one pending request
 * per person per conversation: asking again while one is pending reuses it,
 * so a second press sends no second email.
 *
 * The requester's name is copied in when they ask, because names live in
 * regional D1 and the approver's list is built inside this object. The
 * conversation's title and mark are joined at read time, so a rename shows.
 */
export const CONVERSATION_ACCESS_REQUESTS_MIGRATION: readonly string[] = [
  `CREATE TABLE conversation_access_requests (
    id TEXT PRIMARY KEY,
    parent_id TEXT NOT NULL,
    substream_id TEXT NOT NULL,
    requester_user_id TEXT NOT NULL,
    requester_name TEXT NOT NULL,
    approver_user_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'declined')),
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    -- Set once the approver's email went out; a pending row without it is
    -- emailed again when the person asks again.
    emailed_at INTEGER
  ) STRICT`,
  `CREATE UNIQUE INDEX conversation_access_requests_one_pending
    ON conversation_access_requests (parent_id, substream_id, requester_user_id)
    WHERE status = 'pending'`,
  `CREATE INDEX conversation_access_requests_by_approver
    ON conversation_access_requests (approver_user_id, status)`,
];

/**
 * A conversation's mark as the sidebar and search draw it: a Breakout with no
 * look of its own wears its Channel's, resolved from the Channel's id. The
 * preview and the approver's list both name a conversation this way.
 */
export function conversationMark(input: {
  parentId: string; substreamId: string; appearanceJson: string | null; parentAppearanceJson: string | null;
}): { appearance: z.infer<typeof WorkstreamAppearanceSchema> | null; markId: string } {
  const breakout = input.substreamId !== "0";
  const borrowed = breakout && !input.appearanceJson;
  const json = borrowed ? input.parentAppearanceJson : input.appearanceJson;
  return {
    appearance: json ? WorkstreamAppearanceSchema.parse(JSON.parse(json)) : null,
    markId: borrowed || !breakout ? input.parentId : input.substreamId,
  };
}

export interface StoredAccessRequest {
  id: string;
  parentId: string;
  substreamId: string;
  requesterUserId: string;
  approverUserId: string;
  status: "pending" | "approved" | "declined";
  /** The approver's email went out; asking again sends nothing more. */
  emailed: boolean;
}

type Row = {
  id: string; parent_id: string; substream_id: string; requester_user_id: string;
  approver_user_id: string; status: StoredAccessRequest["status"]; emailed_at: number | null;
};

const COLUMNS = "id, parent_id, substream_id, requester_user_id, approver_user_id, status, emailed_at";

const stored = (row: Row): StoredAccessRequest => ({
  id: row.id,
  parentId: row.parent_id,
  substreamId: row.substream_id,
  requesterUserId: row.requester_user_id,
  approverUserId: row.approver_user_id,
  status: row.status,
  emailed: row.emailed_at !== null,
});

export class ConversationAccessRequestStorage {
  constructor(private readonly sql: SqlStorage) {}

  /** The pending request this person already has for this conversation, or a new one. */
  record(input: {
    id: string; parentId: string; substreamId: string; requesterUserId: string; requesterName: string;
    approverUserId: string; now: number;
  }): { request: StoredAccessRequest; created: boolean } {
    const inserted = this.sql.exec<Row>(
      `INSERT INTO conversation_access_requests
        (id, parent_id, substream_id, requester_user_id, requester_name, approver_user_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
       ON CONFLICT (parent_id, substream_id, requester_user_id) WHERE status = 'pending' DO NOTHING
       RETURNING ${COLUMNS}`,
      input.id, input.parentId, input.substreamId, input.requesterUserId, input.requesterName,
      input.approverUserId, input.now,
    ).toArray()[0];
    if (inserted) return { request: stored(inserted), created: true };
    const existing = this.sql.exec<Row>(
      `SELECT ${COLUMNS}
         FROM conversation_access_requests
        WHERE parent_id = ? AND substream_id = ? AND requester_user_id = ? AND status = 'pending'`,
      input.parentId, input.substreamId, input.requesterUserId,
    ).toArray()[0]!;
    return { request: stored(existing), created: false };
  }

  get(id: string): StoredAccessRequest | null {
    const row = this.sql.exec<Row>(
      `SELECT ${COLUMNS}
         FROM conversation_access_requests WHERE id = ?`, id,
    ).toArray()[0];
    return row ? stored(row) : null;
  }

  /** Settle a pending request. Returns null when it was not pending (already settled either way). */
  resolve(id: string, status: "approved" | "declined", now: number): StoredAccessRequest | null {
    const row = this.sql.exec<Row>(
      `UPDATE conversation_access_requests SET status = ?, resolved_at = ?
        WHERE id = ? AND status = 'pending'
       RETURNING ${COLUMNS}`,
      status, now, id,
    ).toArray()[0];
    return row ? stored(row) : null;
  }

  /** The approver's email went out. */
  markEmailed(id: string, now: number): void {
    this.sql.exec(`UPDATE conversation_access_requests SET emailed_at = ? WHERE id = ? AND emailed_at IS NULL`, now, id);
  }

  /**
   * Put an approval back to pending when the grant it claimed failed, so the
   * approver can try again. `OR IGNORE`: if the person has asked again since,
   * their newer pending request stands and this one stays as it was.
   */
  reopen(id: string): StoredAccessRequest | null {
    const row = this.sql.exec<Row>(
      `UPDATE OR IGNORE conversation_access_requests SET status = 'pending', resolved_at = NULL
        WHERE id = ? AND status = 'approved'
       RETURNING ${COLUMNS}`,
      id,
    ).toArray()[0];
    return row ? stored(row) : null;
  }

  /**
   * One approver's pending requests, newest first, named by the conversation
   * as it is now. A request for a conversation since archived is left out.
   */
  pendingFor(approverUserId: string): ConversationAccessRequestItem[] {
    return this.sql.exec<{
      id: string; parent_id: string; substream_id: string; requester_user_id: string; requester_name: string;
      created_at: number; title: string; appearance_json: string | null; parent_appearance_json: string | null;
    }>(
      `SELECT request.id, request.parent_id, request.substream_id, request.requester_user_id,
              request.requester_name, request.created_at,
              COALESCE(breakout.title, channel.title) AS title,
              CASE WHEN request.substream_id = '0' THEN channel.appearance_json ELSE breakout.appearance_json END
                AS appearance_json,
              channel.appearance_json AS parent_appearance_json
         FROM conversation_access_requests request
         JOIN channels channel ON channel.workstream_id = request.parent_id AND channel.archived_at IS NULL
         LEFT JOIN breakouts breakout ON request.substream_id != '0'
          AND breakout.workstream_id = request.parent_id AND breakout.substream_id = request.substream_id
        WHERE request.approver_user_id = ? AND request.status = 'pending'
          AND (request.substream_id = '0' OR (breakout.substream_id IS NOT NULL AND breakout.archived_at IS NULL))
        ORDER BY request.created_at DESC, request.id`,
      approverUserId,
    ).toArray().map((row) => {
      const breakout = row.substream_id !== "0";
      return ConversationAccessRequestItemSchema.parse({
        id: row.id,
        parentId: row.parent_id,
        substreamId: row.substream_id,
        kind: breakout ? "breakout" : "channel",
        title: row.title,
        ...conversationMark({
          parentId: row.parent_id, substreamId: row.substream_id,
          appearanceJson: row.appearance_json, parentAppearanceJson: row.parent_appearance_json,
        }),
        requesterUserId: row.requester_user_id,
        requesterName: row.requester_name,
        requestedAt: new Date(row.created_at).toISOString(),
      });
    });
  }
}
