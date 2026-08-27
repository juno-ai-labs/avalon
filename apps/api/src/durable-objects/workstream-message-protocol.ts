import { MESSAGE_MAX_CHARACTERS } from "@rally/contracts";
import { z } from "zod";

import {
  type Exhaustive,
  objectPortRequestSchema,
  operationGuard,
  type ObjectPortOf,
} from "./object-port-protocol";
import type { WorkstreamMessageStorage } from "./workstream-message-storage";

export const AppendMessageInputSchema = z.object({
  messageId: z.string().min(1),
  clientMessageId: z.string().min(1),
  authorType: z.enum(["human", "agent", "external", "system"]),
  authorUserId: z.string().min(1).nullable(),
  externalActorJson: z.string().nullable(),
  messageType: z.enum(["text", "system", "elicitation"]),
  text: z.string().max(MESSAGE_MAX_CHARACTERS),
  structuredContentJson: z.string().max(MESSAGE_MAX_CHARACTERS).nullable(),
  producedByRunId: z.string().min(1).nullable(),
  now: z.number().finite(),
}).strict();

export const UpsertToolMessageInputSchema = z.object({
  messageId: z.string().min(1),
  clientMessageId: z.string().min(1),
  structuredContentJson: z.string().max(MESSAGE_MAX_CHARACTERS),
  createdAt: z.number().finite(),
  editedAt: z.number().finite().nullable(),
}).strict();

/**
 * The wire contract for one work stream's transcript.
 *
 * The canonical message records are object-local, but every reader and writer that is not
 * the product service runs in the Worker. This endpoint is how they reach them,
 * in place of D1-shaped SQL rewritten onto `_runtime_messages`.
 */
type LocalOnlyMessageOperation =
  | "prepareMessage"
  | "appendPreparedMessage"
  | "prepareToolMessage"
  | "upsertPreparedToolMessage";
export type MessageOperation = Exclude<keyof WorkstreamMessageStorage, LocalOnlyMessageOperation>;

export type MessageObjectPort = ObjectPortOf<WorkstreamMessageStorage>;

const DISPATCHED_OPERATIONS = [
  "message",
  "messageByClientId",
  "messagesBefore",
  "messagesAfter",
  "messageAtSequence",
  "saidMessages",
  "saidMessageCount",
  "saidWindow",
  "messageFromParticipant",
  "openingAttachmentCount",
  "mentionsFor",
  "attachmentsFor",
  "authorsFor",
  "appendMessage",
  "upsertToolMessage",
] as const satisfies readonly MessageOperation[];

/** Every operation the endpoint will dispatch, proven complete both ways. */
export const MESSAGE_OPERATIONS:
  Exhaustive<MessageOperation, typeof DISPATCHED_OPERATIONS> = DISPATCHED_OPERATIONS;

/**
 * The operations that append to a member-visible transcript.
 *
 * Named here rather than tested for at the endpoint, so an operation added to
 * the storage class without a place in this set is visible next to the list it
 * belongs beside. The endpoint runs these inside `commitRuntimeMutation`: the
 * row and the directory projection showing its preview are one commit.
 */
const TRANSCRIPT_WRITES = new Set<MessageOperation>(["appendMessage", "upsertToolMessage"]);

export function mutatesTranscript(operation: MessageOperation): boolean {
  return TRANSCRIPT_WRITES.has(operation);
}

export const isMessageOperation = operationGuard(MESSAGE_OPERATIONS);

export const MessageOperationRequestSchema = objectPortRequestSchema(
  isMessageOperation,
  "unknown_message_operation",
);

export type MessageOperationRequest = z.infer<typeof MessageOperationRequestSchema>;
