import type {
  WorkspaceSocketClientEventSchema} from "@rally/contracts";
import {
  MESSAGE_MAX_CHARACTERS,
  UserIdSchema,
  WorkspaceIdSchema,
  WorkstreamIdSchema,
} from "@rally/contracts";
import { z } from "zod";

import type { Env } from "../env";
import { logWarn } from "../observability/logger";

/**
 * The workspace command socket's per-connection state and its teardown.
 *
 * A hibernating socket carries everything the object knows about it in its
 * serialized attachment, so the attachment's shape, the reader that tolerates a
 * previous deployment's shape, and the two disconnect paths belong together —
 * they are one contract, and a field added to the attachment has to be given a
 * default here or a socket accepted before the deploy is dropped on resume.
 */

export const SocketIdentitySchema = z.object({
  workspaceId: WorkspaceIdSchema,
  userId: UserIdSchema,
  sessionId: z.string().min(1).max(200),
  ticketId: z.string().uuid(),
  ticketExpiresAt: z.coerce.number().int().positive(),
});

export type SocketIdentity = z.infer<typeof SocketIdentitySchema>;
export type CreateMessageCommand = Extract<
  z.infer<typeof WorkspaceSocketClientEventSchema>,
  { type: "create_message" }
>;

/**
 * The `clientMessageId` of a `create_message` frame whose text is over the
 * ceiling, or null when the frame is anything else.
 *
 * Reads the decoded JSON rather than a parsed command because the parse is what
 * this runs ahead of. Deliberately narrow: it answers only for a frame that is
 * recognisably a create_message carrying a correlatable id, so anything it is
 * unsure about falls through to the schema and is refused there. The reply is
 * correlated by `clientMessageId`, so a frame without a usable one has nothing
 * to answer to and is left to the parse as well.
 */
export function overLongCreateMessageCommand(decoded: unknown): { clientMessageId: string } | null {
  if (decoded === null || typeof decoded !== "object") return null;
  const frame = decoded as { type?: unknown; payload?: unknown };
  if (frame.type !== "create_message") return null;
  if (frame.payload === null || typeof frame.payload !== "object") return null;
  const payload = frame.payload as { text?: unknown; clientMessageId?: unknown };
  if (typeof payload.text !== "string" || payload.text.length <= MESSAGE_MAX_CHARACTERS) return null;
  if (typeof payload.clientMessageId !== "string") return null;
  if (payload.clientMessageId.length < 1 || payload.clientMessageId.length > 120) return null;
  return { clientMessageId: payload.clientMessageId };
}

export interface WorkspaceSocketAttachment extends SocketIdentity {
  connectionId: string;
  connectedAt: string;
  subscribed: boolean;
  lastWaterline: number;
  presenceRevision: number;
  applicationState: "foreground" | "background";
  foregroundWorkstreamId: string | null;
}

export function readAttachment(socket: WebSocket): WorkspaceSocketAttachment | null {
  try {
    const parsed = SocketIdentitySchema.extend({
      connectionId: z.string().uuid(),
      connectedAt: z.string().datetime({ offset: true }),
      subscribed: z.boolean(),
      lastWaterline: z.number().int().nonnegative(),
      // Sockets accepted by the previous deployment carry none of these fields. They
      // resume safely as backgrounded and write the explicit shape on their
      // first presence event instead of being disconnected during rollout.
      presenceRevision: z.number().int().nonnegative().default(0),
      applicationState: z.enum(["foreground", "background"]).default("background"),
      foregroundWorkstreamId: WorkstreamIdSchema.nullable().default(null),
    }).safeParse(socket.deserializeAttachment());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function contributesPresence(
  attachment: WorkspaceSocketAttachment | null,
): attachment is WorkspaceSocketAttachment & {
  subscribed: true;
  applicationState: "foreground";
  foregroundWorkstreamId: string;
} {
  return attachment?.subscribed === true
    && attachment.applicationState === "foreground"
    && attachment.foregroundWorkstreamId !== null;
}

/**
 * Stop sending to a socket, then close it.
 *
 * The attachment is marked unsubscribed first because that is the filter both
 * publish loops apply. Closing alone would leave the guarantee to the runtime —
 * `send` on a closed socket throws, and both loops catch that throw — so a
 * disconnected listener would be spared the next payload by accident rather
 * than on purpose. On an access path that is the wrong place for the rule to
 * live.
 */
export function disconnect(socket: WebSocket, code: number, reason: string): void {
  const attachment = readAttachment(socket);
  if (attachment) {
    try {
      socket.serializeAttachment({ ...attachment, subscribed: false } satisfies WorkspaceSocketAttachment);
    } catch {
      // An unreadable attachment already fails both publish filters.
    }
  }
  try {
    socket.close(code, reason);
  } catch {
    // Already closing or closed; the runtime owns the rest of the teardown.
  }
}

export type WorkspaceSocketOperation =
  | "attachment"
  | "decode"
  | "validate"
  | "subscribe"
  | "presence"
  | "list_workstreams"
  | "create_message";

export interface WorkspaceSocketCloseInput {
  code: number;
  reason: string;
  cause: string;
  operation: WorkspaceSocketOperation;
  frameBytes?: number;
  validationIssues?: ReadonlyArray<{ path: string; code: string }>;
}

export function closeWorkspaceSocket(
  env: Env,
  socket: WebSocket,
  attachment: WorkspaceSocketAttachment | null,
  input: WorkspaceSocketCloseInput,
): void {
  logWarn(env, "workspace_socket_closed", {
    code: input.cause,
    close_code: input.code,
    close_reason: input.reason,
    operation: input.operation,
    ...(input.frameBytes === undefined ? {} : { frame_bytes: input.frameBytes }),
    ...(input.validationIssues ? { validation_issues: input.validationIssues.slice(0, 25) } : {}),
    ...(attachment
      ? {
        workspace_id: attachment.workspaceId,
        user_id: attachment.userId,
        session_id: attachment.sessionId,
        connection_id: attachment.connectionId,
      }
      : {}),
  });
  disconnect(socket, input.code, input.reason);
}
