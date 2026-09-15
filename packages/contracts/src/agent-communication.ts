import { z } from "zod";
import { ConversationParentKindSchema } from "./conversation-parent";
import { IdSchema, SubstreamIdSchema } from "./identifiers";
import { MESSAGE_MAX_CHARACTERS } from "./message-limits";

/** A conversation address within the host's workspace, not a separately allocated agent identity. */
export const AgentAddressSchema = z.strictObject({
  parentKind: ConversationParentKindSchema,
  parentId: IdSchema,
  substreamId: SubstreamIdSchema,
});
export type AgentAddress = z.infer<typeof AgentAddressSchema>;

function parseAddress(value: string) {
  const parts = value.split("/");
  if (parts.length !== 3) return null;
  const parsed = AgentAddressSchema.safeParse({ parentKind: parts[0], parentId: parts[1], substreamId: parts[2] });
  return parsed.success ? parsed.data : null;
}

export const AgentIdSchema = z.string().refine((value) => parseAddress(value) !== null, {
  message: "Use an exact agentId returned by agent or Sidekick discovery.",
}).brand<"AgentId">();
export type AgentId = z.infer<typeof AgentIdSchema>;

/** Host routing context for the message that activated an execution. */
export const AgentExchangeSchema = z.strictObject({
  teamId: AgentIdSchema,
  messageId: IdSchema,
  senderAgentId: AgentIdSchema,
});
export type AgentExchange = z.infer<typeof AgentExchangeSchema>;

export function agentIdForAddress(address: AgentAddress): AgentId {
  const parsed = AgentAddressSchema.parse(address);
  return AgentIdSchema.parse(`${parsed.parentKind}/${parsed.parentId}/${parsed.substreamId}`);
}

export function agentAddressForId(agentId: AgentId): AgentAddress {
  return AgentAddressSchema.parse(parseAddress(agentId));
}

const MessageFields = {
  message: z.string().max(MESSAGE_MAX_CHARACTERS).describe("Tell the recipient what to do or provide your response. Include the context it needs."),
  // Same identifiers, default and bound as SubstreamOpeningMessageSchema.
  attachmentIds: z.array(IdSchema).max(10).default([])
    .describe("Resource IDs already attached to this conversation. Omit when no attachments are needed."),
};
const hasContent = (value: { message: string; attachmentIds: string[] }) =>
  value.message.trim().length > 0 || value.attachmentIds.length > 0;
const contentError = { message: "Include a message or at least one attachment." };

export const StartAgentInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(500).describe("Give the agent a short name so teammates can recognize it."),
  description: z.string().trim().min(1).max(4_000).describe("Describe the agent’s job for teammates. Put the full assignment in message."),
  ...MessageFields,
}).refine(hasContent, contentError);
export const StartAgentResultSchema = z.strictObject({ agentId: AgentIdSchema });
export const ListAgentsInputSchema = z.strictObject({});
export const SendAgentMessageInputSchema = z.strictObject({
  agentId: AgentIdSchema.describe("Copy the recipient’s agentId from creation or discovery. Do not use a Sidekick ID."),
  ...MessageFields,
}).refine(hasContent, contentError);
export const ReplyToAgentMessageInputSchema = z.strictObject({
  messageId: IdSchema.describe("Copy Message ID from the message you received. The response goes to its sender."),
  ...MessageFields,
}).refine(hasContent, contentError);
export const AgentMessageResultSchema = z.strictObject({ messageId: IdSchema });
export const StopAgentInputSchema = z.strictObject({
  agentId: AgentIdSchema.describe("Copy the agentId of an agent you own. Its owned descendants also stop."),
});

export type StartAgentInput = z.infer<typeof StartAgentInputSchema>;
export type SendAgentMessageInput = z.infer<typeof SendAgentMessageInputSchema>;
export type ReplyToAgentMessageInput = z.infer<typeof ReplyToAgentMessageInputSchema>;
