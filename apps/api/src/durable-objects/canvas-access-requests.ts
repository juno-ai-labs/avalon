import { truncateUtf16Safe } from "@rally/contracts/text";
import { PUSH_BODY_PREVIEW_CHARACTERS } from "@rally/contracts/push-notifications";

import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { sha256 } from "../lib/crypto";
import { uuidV7 } from "../lib/uuid-v7";
import { logInfo } from "../observability/logger";
import { enqueuePushDelivery } from "../services/push-delivery-service";
import { workspaceRegionalDatabase } from "../services/workspace-runtime-database";
import { MEMORY_DIGEST_CANVAS_SIDEKICK_TRIGGERS_MIGRATION } from "./memory-digest-sync";
import type { NoteActivity } from "./workspace-activity";
import type { ParentNotice } from "./workspace-notification-intent-protocol";
import { recordParentNotice } from "./workspace-notification-intent-storage";

/**
 * WorkspaceDO migration 151: a member's request to open a Canvas they cannot
 * open, and the participant source it seats them with.
 *
 * One row per request. At most one is `pending` per (Canvas, person) — the
 * partial unique index — so asking again while one waits answers that one;
 * a settled row stays as the record of who decided and when, so asking
 * again after a denial is a new row. The requester's and the decider's names
 * are taken when each acts, so the decider's Activity row and the Share
 * panel name them without a read of D1. `docs/canvas-access-requests.md`
 * owns the mechanism.
 *
 * `canvas_participants.source` gains `request`; the CHECK cannot widen in
 * place, nothing references the table by foreign key, so it is copied as
 * migration 139 made it, and its index and the two memory-digest triggers
 * migration 144 hung on it are made again.
 */
export const CANVAS_ACCESS_REQUESTS_STATEMENTS: readonly string[] = [
  `CREATE TABLE canvas_access_requests (
    request_id TEXT PRIMARY KEY,
    canvas_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    requester_name TEXT NOT NULL,
    message TEXT,
    state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'denied')),
    decided_by_user_id TEXT,
    decided_by_name TEXT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    decided_at INTEGER,
    CHECK ((state = 'pending') = (decided_at IS NULL))
  ) STRICT`,
  `CREATE UNIQUE INDEX canvas_access_requests_pending_idx ON canvas_access_requests(canvas_id, user_id) WHERE state = 'pending'`,
  `CREATE INDEX canvas_access_requests_requester_idx ON canvas_access_requests(canvas_id, user_id, created_at DESC)`,
  `CREATE TABLE canvas_participants_v151 (
    canvas_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('added', 'invitation', 'request')),
    added_by_user_id TEXT,
    added_at INTEGER NOT NULL CHECK (added_at >= 0),
    PRIMARY KEY (canvas_id, user_id)
  ) STRICT`,
  `INSERT INTO canvas_participants_v151 (canvas_id, user_id, source, added_by_user_id, added_at)
     SELECT canvas_id, user_id, source, added_by_user_id, added_at FROM canvas_participants`,
  `DROP TABLE canvas_participants`,
  `ALTER TABLE canvas_participants_v151 RENAME TO canvas_participants`,
  `CREATE INDEX canvas_participants_user_idx ON canvas_participants(user_id, canvas_id)`,
  ...MEMORY_DIGEST_CANVAS_SIDEKICK_TRIGGERS_MIGRATION.filter((statement) => statement.includes(" ON canvas_participants ")),
];

/** What a request and its decision need from the Organization object that holds the Canvas. */
export interface CanvasAccessHost {
  env: Env;
  storage: DurableObjectStorage;
  /** Reads a person's relationship into the object, so their Activity lists a request about a Canvas they open by role. */
  readRelationship(workspaceId: string, userId: string): Promise<unknown>;
  noteActivityChanged: NoteActivity;
  noteCanvasDirectoryChanged(canvasId: string): void;
}

/** The Canvas a request is about, as its row says now. */
export interface CanvasAccessSubject {
  canvasId: string;
  workspaceId: string;
  title: string;
  creatorUserId: string;
  generation: number;
}

interface RequestRow extends Record<string, SqlStorageValue> {
  request_id: string;
  user_id: string;
  requester_name: string;
  message: string | null;
  state: "pending" | "approved" | "denied";
  created_at: number;
}

/** A person's name as the Organization knows them, for a notice that names them. */
async function personName(env: Env, workspaceId: string, userId: string): Promise<string> {
  const person = await env.DB.prepare(
    `SELECT person.name FROM users person JOIN workspace_members member ON member.user_id = person.id AND member.workspace_id = ?
      WHERE person.id = ?`,
  ).bind(workspaceId, userId).first<{ name: string | null }>();
  return truncateUtf16Safe(person?.name || "Someone", 180);
}

/**
 * Who is told a request waits: the people the 2026-11-07 decision lets manage
 * a Canvas's participants — its creator, and the Organization's owners and
 * administrators — who are active, never the requester. A writer Sidekick's
 * managers may also decide (`canvasManages`) but are not told.
 */
async function deciders(env: Env, subject: CanvasAccessSubject, requesterUserId: string): Promise<string[]> {
  const rows = await workspaceRegionalDatabase(env).prepare(
    `SELECT user_id FROM workspace_members
      WHERE workspace_id = ? AND status = 'active' AND (user_id = ? OR role IN ('owner', 'admin'))`,
  ).bind(subject.workspaceId, subject.creatorUserId).all<{ user_id: string }>();
  return [...new Set(rows.results.map((row) => row.user_id))].filter((userId) => userId !== requesterUserId).sort();
}

/** The request waiting for this person on this Canvas, if one does. */
export function pendingAccessRequest(sql: SqlStorage, canvasId: string, userId: string): RequestRow | null {
  return sql.exec<RequestRow>(
    `SELECT request_id, user_id, requester_name, message, state, created_at FROM canvas_access_requests
      WHERE canvas_id = ? AND user_id = ? AND state = 'pending'`, canvasId, userId,
  ).toArray()[0] ?? null;
}

/** This person's latest request to open this Canvas, pending or denied, for the pane that offers to ask. */
export function latestAccessRequest(sql: SqlStorage, canvasId: string, userId: string): { state: "pending" | "denied"; requestedAt: string } | null {
  const row = sql.exec<{ state: string; created_at: number }>(
    `SELECT state, created_at FROM canvas_access_requests WHERE canvas_id = ? AND user_id = ?
      ORDER BY created_at DESC, request_id DESC LIMIT 1`, canvasId, userId,
  ).toArray()[0];
  return row && (row.state === "pending" || row.state === "denied") ? { state: row.state, requestedAt: new Date(row.created_at).toISOString() } : null;
}

/** Every request waiting on this Canvas, oldest first, as the Share panel lists them. */
export function pendingAccessRequests(sql: SqlStorage, canvasId: string): { userId: string; name: string; message: string | null; requestedAt: string }[] {
  return sql.exec<RequestRow>(
    `SELECT request_id, user_id, requester_name, message, state, created_at FROM canvas_access_requests
      WHERE canvas_id = ? AND state = 'pending' ORDER BY created_at, request_id`, canvasId,
  ).toArray().map((row) => ({ userId: row.user_id, name: row.requester_name, message: row.message, requestedAt: new Date(row.created_at).toISOString() }));
}

/** The message as stored: trimmed, cut to the push's preview length, and none when empty. */
function storedMessage(message: string | undefined): string | null {
  const trimmed = message?.trim() ?? "";
  if (trimmed === "") return null;
  const characters = Array.from(trimmed);
  return characters.length > PUSH_BODY_PREVIEW_CHARACTERS ? characters.slice(0, PUSH_BODY_PREVIEW_CHARACTERS).join("") : trimmed;
}

/**
 * Ask to open a Canvas. The caller has already decided the person is a
 * member who may not open it. A request already waiting is the answer; a
 * new one tells each decider with an `access_request` intent and an Activity
 * row whose actions decide it, and enqueues their pushes.
 */
export async function requestCanvasAccess(host: CanvasAccessHost, subject: CanvasAccessSubject, requesterUserId: string,
  message: string | undefined): Promise<void> {
  if (pendingAccessRequest(host.storage.sql, subject.canvasId, requesterUserId)) return;
  const [requesterName, told] = await Promise.all([
    personName(host.env, subject.workspaceId, requesterUserId), deciders(host.env, subject, requesterUserId),
  ]);
  // An administrator's Activity lists a Canvas they open by role from the
  // relationship the object keeps; read each decider's in now.
  await Promise.all(told.map((userId) => host.readRelationship(subject.workspaceId, userId)));
  const requestId = uuidV7();
  const stored = storedMessage(message);
  const notice: ParentNotice = {
    kind: "access_request", parentId: subject.canvasId, parentTitle: subject.title, requestId, requesterName, message: stored,
  };
  const payloadJson = JSON.stringify(notice);
  const payloadHash = await sha256(payloadJson);
  const now = Date.now();
  const recorded = host.storage.transactionSync(() => {
    // The partial index is the one-pending rule; a request that raced this
    // one past the read above is the one that stands.
    const inserted = host.storage.sql.exec(
      `INSERT INTO canvas_access_requests (request_id, canvas_id, user_id, requester_name, message, state, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?) ON CONFLICT DO NOTHING RETURNING request_id`,
      requestId, subject.canvasId, requesterUserId, requesterName, stored, now,
    ).toArray().length === 1;
    if (!inserted) return [];
    return told.map((recipientUserId) => ({
      recipientUserId,
      ...recordParentNotice(host.storage, {
        workspaceId: subject.workspaceId, parentId: subject.canvasId, generation: subject.generation, kind: "access_request",
        recipientUserId, intentId: `access_request:${requestId}:${recipientUserId}`, sourceId: `access_request:${requestId}`,
        payloadJson, payloadHash, skipCode: null, collapse: false,
        activity: {
          parentKind: "canvas", parentId: subject.canvasId, substreamId: "0", messageId: null, runId: null,
          actorKind: "person", actorId: requesterUserId, text: stored,
          // Cleared by being settled or by Mark all seen, never by a read.
          attentionOrdinal: null, subjectId: requestId,
        },
      }, now, host.noteActivityChanged),
    }));
  });
  await enqueue(host, subject.workspaceId, recorded);
  logInfo(host.env, "canvas_access_requested", { canvas_id: subject.canvasId, request_id: requestId, deciders: recorded.length });
}

/**
 * Settle a waiting request, by a decision or because the person was let in
 * some other way. `seat` adds them to the participant list (an approval); a
 * Canvas they already open is not changed. Every decider's row about it now
 * reads as settled, and an approval tells the requester with an
 * `access_granted` intent and row naming who let them in. Answers the state
 * it settled in, or null when nothing was waiting.
 */
export async function settleCanvasAccessRequest(host: CanvasAccessHost, subject: CanvasAccessSubject, input: {
  requesterUserId: string; deciderUserId: string; state: "approved" | "denied"; seat: boolean;
}): Promise<"approved" | "denied" | null> {
  const request = pendingAccessRequest(host.storage.sql, subject.canvasId, input.requesterUserId);
  if (!request) return null;
  const deciderName = await personName(host.env, subject.workspaceId, input.deciderUserId);
  const notice: ParentNotice = {
    kind: "access_granted", parentId: subject.canvasId, parentTitle: subject.title, requestId: request.request_id, deciderName,
  };
  const payloadJson = JSON.stringify(notice);
  const payloadHash = await sha256(payloadJson);
  const now = Date.now();
  const settled = host.storage.transactionSync(() => {
    const moved = host.storage.sql.exec(
      `UPDATE canvas_access_requests SET state = ?, decided_by_user_id = ?, decided_by_name = ?, decided_at = ?
        WHERE request_id = ? AND state = 'pending' RETURNING request_id`,
      input.state, input.deciderUserId, deciderName, now, request.request_id,
    ).toArray().length === 1;
    if (!moved) return null;
    for (const row of host.storage.sql.exec<{ recipient_user_id: string }>(
      `SELECT recipient_user_id FROM workspace_activity_items WHERE kind = 'access_request' AND subject_id = ?`, request.request_id,
    ).toArray()) host.noteActivityChanged(row.recipient_user_id);
    if (input.state === "denied") return [];
    if (input.seat) {
      host.storage.sql.exec(
        `INSERT INTO canvas_participants (canvas_id, user_id, source, added_by_user_id, added_at)
         VALUES (?, ?, 'request', ?, ?) ON CONFLICT(canvas_id, user_id) DO NOTHING`,
        subject.canvasId, input.requesterUserId, input.deciderUserId, now,
      );
      // A Canvas open to its creator alone becomes one open to its participants, as a claimed share makes it.
      host.storage.sql.exec(`UPDATE canvas_directory SET visibility = 'participants', updated_at = MAX(updated_at, ?)
        WHERE canvas_id = ? AND visibility = 'creator'`, now, subject.canvasId);
      host.noteCanvasDirectoryChanged(subject.canvasId);
    }
    return [{
      recipientUserId: input.requesterUserId,
      ...recordParentNotice(host.storage, {
        workspaceId: subject.workspaceId, parentId: subject.canvasId, generation: subject.generation, kind: "access_granted",
        recipientUserId: input.requesterUserId, intentId: `access_granted:${request.request_id}`, sourceId: `access_granted:${request.request_id}`,
        payloadJson, payloadHash, skipCode: null, collapse: false,
        activity: {
          parentKind: "canvas", parentId: subject.canvasId, substreamId: "0", messageId: null, runId: null,
          actorKind: "person", actorId: input.deciderUserId, text: null, subjectId: request.request_id,
        },
      }, now, host.noteActivityChanged),
    }];
  });
  if (settled === null) return null;
  await enqueue(host, subject.workspaceId, settled);
  logInfo(host.env, "canvas_access_settled", { canvas_id: subject.canvasId, request_id: request.request_id, state: input.state });
  return input.state;
}

/** Every request waiting on this Canvas whose person it now admits, approved by whoever let them in. */
export async function settleAdmittedAccessRequests(host: CanvasAccessHost, subject: CanvasAccessSubject, deciderUserId: string,
  admits: (userId: string) => boolean): Promise<void> {
  for (const request of pendingAccessRequests(host.storage.sql, subject.canvasId)) {
    if (!admits(request.userId)) continue;
    await settleCanvasAccessRequest(host, subject, { requesterUserId: request.userId, deciderUserId, state: "approved", seat: false });
  }
}

async function enqueue(host: CanvasAccessHost, workspaceId: string, intents: { recipientUserId: string; intentId: string; push: boolean }[]): Promise<void> {
  for (const intent of intents) {
    if (!intent.push) continue;
    await enqueuePushDelivery(host.env, { region: host.env.AVALON_REGION, workspaceId, recipientUserId: intent.recipientUserId, intentId: intent.intentId });
  }
}

/** The refusals the routes name. */
export const accessRefusals = {
  notMember: () => new ApiError(403, "canvas_access_request_not_member", "Only a member of the Organization can ask to open a Canvas"),
  notManager: () => new ApiError(403, "canvas_access_decision_not_manager", "Only someone who manages this Canvas's people can decide"),
  settled: () => new ApiError(409, "canvas_access_request_settled", "That request has already been decided"),
  open: () => new ApiError(409, "canvas_access_open", "You can already open this Canvas"),
};
