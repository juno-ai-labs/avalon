import { IdSchema } from "@rally/contracts";
import { z } from "zod";

/**
 * Dictation admission, as one question to the workspace rather than four.
 *
 * Admitting a realtime transcription socket is a sequence: sweep what has
 * expired, consume the one-time ticket so a replay cannot open a second
 * socket, then insert a session only if neither concurrency cap is already
 * met. Every step reads and writes tables only WorkspaceDO has, and the
 * service used to issue them as four separate statements through the workspace
 * runtime facade — four round trips, and four independent critical sections,
 * so the sweep, the consumption and the cap check were never one decision even
 * though the code read as though they were.
 *
 * As a method they are, and the caps travel with the operation rather than
 * being restated by whoever calls it: admission policy belongs to the object
 * that holds the sessions.
 */
export const WorkspaceTranscriptionAdmitRequestSchema = z.object({
  workspaceId: IdSchema,
  userId: IdSchema,
  /** The socket ticket being spent; consuming it is what makes it one-time. */
  ticketId: z.string().min(1).max(300),
  /** The ticket's own expiry, kept so the receipt can be swept on its schedule. */
  ticketExpiresAtSeconds: z.number().int().nonnegative(),
  sessionId: IdSchema,
  nowSeconds: z.number().int().nonnegative(),
}).strict();

/**
 * Why admission ended, as data rather than as a thrown error.
 *
 * A refusal here is an ordinary answer — a replayed ticket and a workspace at
 * its cap are both things a person can hit — and the sentence a person reads
 * is the service's to choose, so the object names the outcome and the service
 * maps it to an `ApiError`. Throwing across RPC would arrive as a bare message
 * with the status lost.
 */
export const WorkspaceTranscriptionAdmitResultSchema = z.object({
  outcome: z.enum(["admitted", "ticket_replayed", "concurrency_limit"]),
  /** When the admitted session's lease runs out; absent on a refusal. */
  expiresAtSeconds: z.number().int().nonnegative().nullable(),
}).strict();

export const WorkspaceTranscriptionSessionRequestSchema = z.object({
  workspaceId: IdSchema,
  sessionId: IdSchema,
}).strict();

export const WorkspaceTranscriptionRenewRequestSchema = WorkspaceTranscriptionSessionRequestSchema
  .extend({ nowSeconds: z.number().int().nonnegative() });

export const WorkspaceTranscriptionRenewResultSchema = z.object({
  /**
   * False when the session was already gone — swept, or released by the peer
   * that owned it. The caller stops renewing rather than resurrecting a lease
   * for a socket nobody is holding.
   */
  renewed: z.boolean(),
  expiresAtSeconds: z.number().int().nonnegative().nullable(),
}).strict();

export type WorkspaceTranscriptionAdmitRequest = z.infer<
  typeof WorkspaceTranscriptionAdmitRequestSchema
>;
export type WorkspaceTranscriptionAdmitResult = z.infer<
  typeof WorkspaceTranscriptionAdmitResultSchema
>;
export type WorkspaceTranscriptionSessionRequest = z.infer<
  typeof WorkspaceTranscriptionSessionRequestSchema
>;
export type WorkspaceTranscriptionRenewRequest = z.infer<
  typeof WorkspaceTranscriptionRenewRequestSchema
>;
export type WorkspaceTranscriptionRenewResult = z.infer<
  typeof WorkspaceTranscriptionRenewResultSchema
>;
