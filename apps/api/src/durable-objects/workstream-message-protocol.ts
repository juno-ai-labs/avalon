import { MESSAGE_MAX_CHARACTERS } from "@rally/contracts";
import { z } from "zod";
import { deferredZodSchema } from "@rally/contracts/deferred-zod-schema";

import {
  type Exhaustive,
  objectPortRequestSchema,
  operationGuard,
  type ObjectPortOf,
} from "./object-port-protocol";
import type { WorkstreamMessageStorage } from "./workstream-message-storage";

export const AppendMessageInputSchema = z.strictObject({
  messageId: z.string().min(1),
  clientMessageId: z.string().min(1),
  authorType: z.enum(["agent", "external", "system"]),
  authorUserId: z.null(),
  externalActorJson: z.string().nullable(),
  messageType: z.enum(["text", "system", "elicitation", "automation_activation"]),
  text: z.string().max(MESSAGE_MAX_CHARACTERS),
  structuredContentJson: z.string().max(MESSAGE_MAX_CHARACTERS).nullable(),
  producedByRunId: z.string().min(1).nullable(),
  now: z.number().finite(),
});

/**
 * The wire contract for one work stream's transcript.
 *
 * Canonical conversation turns are object-local, but every reader and writer that is not
 * the product service runs in the Worker. This endpoint is how they reach those turns,
 * in place of D1-shaped SQL rewritten onto `_runtime_messages`.
 */
type LocalOnlyMessageOperation =
  | "prepareMessage"
  | "appendPreparedMessage";
export type MessageOperation = Exclude<keyof WorkstreamMessageStorage, LocalOnlyMessageOperation>;

export type MessageObjectPort = ObjectPortOf<WorkstreamMessageStorage, MessageOperation>;

const DISPATCHED_OPERATIONS = [
  "message",
  "messageByClientId",
  "messagesBefore",
  "readableMessagesBefore",
  "messagesAfter",
  "hasMessageAfter",
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
const TRANSCRIPT_WRITES = new Set<MessageOperation>(["appendMessage"]);

export function mutatesTranscript(operation: MessageOperation): boolean {
  return TRANSCRIPT_WRITES.has(operation);
}

export const isMessageOperation = operationGuard(MESSAGE_OPERATIONS);

export const MessageOperationRequestSchema = deferredZodSchema(() => objectPortRequestSchema(
  isMessageOperation,
  "unknown_message_operation",
));

export type MessageOperationRequest = z.infer<typeof MessageOperationRequestSchema>;
