import { CreateMessageRequestSchema } from "@rally/contracts";

import type {
  EngineeringTextResult,
  ReadEngineeringConversationInput,
  SendEngineeringMessageInput,
  SendEngineeringMessageResult,
} from "@rally/contracts/engineering-inspection";

import type { Env } from "../env";
import { engineeringUserAuth } from "./engineering-creation";
import { ApiError } from "../lib/api-error";
import { ConversationService } from "./conversation-service";

export async function sendEngineeringMessage(env: Env, input: SendEngineeringMessageInput): Promise<SendEngineeringMessageResult> {
  const message = CreateMessageRequestSchema.parse({ ...input, clientMessageId: input.operationId });
  const auth = await engineeringUserAuth(env, input.orgId, input.userId, input.operationId);
  // A Canvas id reaches its Chat and a Sidekick id its shared conversation:
  // the parent resolves the kind, and authorizes this user, as the app does.
  const client = await new ConversationService(env, auth).writableClient(input.conversationId);
  const receipt = await client.createMessage(input.recordOnly ? { ...message, recordOnly: true } : message);
  return { receipt };
}

export async function readEngineeringConversation(env: Env, input: ReadEngineeringConversationInput): Promise<EngineeringTextResult> {
  const auth = await engineeringUserAuth(env, input.orgId, input.userId);
  const page = await new ConversationService(env, auth).readText(input.conversationId, { afterSequence: input.afterSequence,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.throughSequence === undefined ? {} : { throughSequence: input.throughSequence }),
  });
  const expected = input.kind === "canvas" ? "canvas" : "automation";
  if (page.kind !== expected) {
    throw new ApiError(409, "conversation_kind_mismatch", `conversation_kind_mismatch:${input.kind}`,
      undefined, `conversation_kind_mismatch:${input.kind}`);
  }
  const kind = input.kind === "canvas" ? "Canvas" : "Sidekick";
  const continuation = page.nextAfterSequence === null ? "" :
    `\n\nMore history: call again with afterSequence=${page.nextAfterSequence} and throughSequence=${page.throughSequence}.`;
  return { text: `${kind}: ${page.title}\n\n${page.text || "No messages."}${continuation}` };
}
