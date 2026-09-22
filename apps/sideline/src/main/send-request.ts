import {
  CreateMessageRequestSchema,
  SidelineSendRequestSchema,
  SidelineSendResponseSchema,
  WorkstreamMessageAdmissionReceiptSchema,
  type SidelineSendRequest,
  type SidelineSendResponse,
} from "@rally/contracts";

export type SidelineHttpSend =
  | {
    kind: "self";
    path: string;
    body: ReturnType<typeof CreateMessageRequestSchema.parse>;
    operationId: string;
  }
  | {
    kind: "represented";
    path: "/sideline/messages";
    body: SidelineSendRequest;
  };

export function sidelineHttpSend(currentUserId: string, input: SidelineSendRequest): SidelineHttpSend {
  if (input.representedUserId !== currentUserId) {
    return { kind: "represented", path: "/sideline/messages", body: SidelineSendRequestSchema.parse(input) };
  }
  return {
    kind: "self",
    path: `/conversations/${encodeURIComponent(input.workstreamId)}/substreams/${encodeURIComponent(input.substreamId)}/messages`,
    operationId: input.idempotencyKey,
    body: CreateMessageRequestSchema.parse({
      text: input.message,
      clientMessageId: input.idempotencyKey,
      mentions: [],
      confirmedParticipantUserIds: [],
      attachmentIds: [],
    }),
  };
}

export function sidelineHttpSendResponse(kind: SidelineHttpSend["kind"], raw: unknown): SidelineSendResponse {
  if (kind === "represented") return SidelineSendResponseSchema.parse(raw);
  const receipt = WorkstreamMessageAdmissionReceiptSchema.parse(raw);
  return SidelineSendResponseSchema.parse({
    messageId: receipt.turn.turnId,
    createdAt: receipt.turn.createdAt,
  });
}
