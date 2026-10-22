import {
  ConversationAccessRequestItemSchema, IdSchema, SubstreamIdSchema, WorkspaceIdSchema, WorkstreamAppearanceSchema,
  type ConversationAccessRequestItem,
} from "@rally/contracts";
import { z } from "zod";

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

/** Both sides of each request RPC, parsed by the Organization object (`parseRpcInput` on the way in). */
export const AccessRequestSubjectRequestSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema, parentId: IdSchema, substreamId: SubstreamIdSchema,
  requesterUserId: IdSchema.optional(),
});
export const AccessRequestSubjectSchema = z.strictObject({
  kind: z.enum(["channel", "breakout"]),
  title: z.string(),
  appearance: WorkstreamAppearanceSchema.nullable(),
  markId: IdSchema,
  createdByUserId: IdSchema.nullable(),
  requestPending: z.boolean(),
  requestEmailed: z.boolean(),
}).nullable();
export const RecordAccessRequestSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema, parentId: IdSchema, substreamId: SubstreamIdSchema,
  requesterUserId: IdSchema, requesterName: z.string(), approverUserId: IdSchema,
});
export const AccessRequestRefSchema = z.strictObject({ workspaceId: WorkspaceIdSchema, id: IdSchema });
export const ResolveAccessRequestSchema = AccessRequestRefSchema.extend({ status: z.enum(["approved", "declined"]) });

export const StoredAccessRequestSchema = z.strictObject({
  id: IdSchema,
  parentId: IdSchema,
  substreamId: SubstreamIdSchema,
  requesterUserId: IdSchema,
  approverUserId: IdSchema,
  status: z.enum(["pending", "approved", "declined"]),
  /** The approver's email went out; asking again sends nothing more. */
  emailed: z.boolean(),
});
export type StoredAccessRequest = z.infer<typeof StoredAccessRequestSchema>;

type Row = {
  id: string; parent_id: string; substream_id: string; requester_user_id: string;
  approver_user_id: string; status: StoredAccessRequest["status"]; emailed_at: number | null;
};

const COLUMNS = "id, parent_id, substream_id, requester_user_id, approver_user_id, status, emailed_at";

const stored = (row: Row): StoredAccessRequest => StoredAccessRequestSchema.parse({
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

  pending(parentId: string, substreamId: string, requesterUserId: string): StoredAccessRequest | null {
    if (!this.tablePresent()) return null;
    const row = this.sql.exec<Row>(
      `SELECT ${COLUMNS} FROM conversation_access_requests
        WHERE parent_id = ? AND substream_id = ? AND requester_user_id = ? AND status = 'pending'`,
      parentId, substreamId, requesterUserId,
    ).toArray()[0];
    return row ? stored(row) : null;
  }

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

  /**
   * Who is waiting to answer a request for any of these Channels: the people
   * whose list names them, so a rename or an archive reaches it at once.
   */
  approversFor(parentIds: readonly string[]): string[] {
    if (parentIds.length === 0 || !this.tablePresent()) return [];
    return this.sql.exec<{ approver_user_id: string }>(
      `SELECT DISTINCT approver_user_id FROM conversation_access_requests
        WHERE status = 'pending' AND parent_id IN (SELECT value FROM json_each(?))`,
      JSON.stringify(parentIds),
    ).toArray().map((row) => row.approver_user_id);
  }

  /** Migration 95 has run here: an object held below it has nothing to list. */
  private tablePresent(): boolean {
    return this.sql.exec(
      `SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'conversation_access_requests'`,
    ).toArray().length === 1;
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
   *
   * Read on every connect, so it answers rather than aborts on an object held
   * below the schemas it reads: with no request table there is nothing to
   * list, and without the Breakout projection (`breakoutsReady`) only Channel
   * requests are. An unguarded read here does not hide requests, it stops the
   * sidebar opening.
   */
  pendingFor(approverUserId: string, breakoutsReady: boolean): ConversationAccessRequestItem[] {
    if (!this.tablePresent()) return [];
    // The Breakout projection predates its `appearance_json` column, so an
    // object that has one may not have the other; a Breakout then wears its
    // Channel's look, as one with no look of its own does.
    const breakoutAppearance = breakoutsReady && this.sql.exec(
      `SELECT 1 FROM pragma_table_info('breakouts') WHERE name = 'appearance_json'`,
    ).toArray().length === 1;
    const breakoutRows = !breakoutsReady
      ? `SELECT NULL AS workstream_id, NULL AS substream_id, NULL AS title, NULL AS appearance_json, NULL AS archived_at WHERE 0`
      : `SELECT workstream_id, substream_id, title, ${breakoutAppearance ? "appearance_json" : "NULL AS appearance_json"},
           archived_at FROM breakouts`;
    const breakoutJoin = `LEFT JOIN (${breakoutRows}) breakout ON request.substream_id != '0'
          AND breakout.workstream_id = request.parent_id AND breakout.substream_id = request.substream_id`;
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
         ${breakoutJoin}
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
