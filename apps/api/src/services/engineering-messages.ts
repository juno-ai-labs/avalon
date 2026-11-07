import { CreateMessageRequestSchema } from "@rally/contracts";

import type {
  EngineeringTextResult,
  ReadEngineeringConversationInput,
  SendEngineeringMessageInput,
  SendEngineeringMessageResult,
} from "@rally/contracts/engineering-inspection";

import type { Env } from "../env";
import { engineeringUserAuth } from "./engineering-creation";
import { ConversationService } from "./conversation-service";

export async function sendEngineeringMessage(env: Env, input: SendEngineeringMessageInput): Promise<SendEngineeringMessageResult> {
  const message = CreateMessageRequestSchema.parse({ ...input, clientMessageId: input.operationId });
  const auth = await engineeringUserAuth(env, input.orgId, input.userId, input.operationId);
  const client = await new ConversationService(env, auth).writableClient(input.threadId, input.breakoutId ?? "0");
  const receipt = await client.createMessage(input.recordOnly ? { ...message, recordOnly: true } : message);
  return { receipt };
}

export async function readEngineeringConversation(env: Env, input: ReadEngineeringConversationInput): Promise<EngineeringTextResult> {
  const auth = await engineeringUserAuth(env, input.orgId, input.userId);
  const client = await new ConversationService(env, auth).client(input.threadId, false, input.breakoutId ?? "0");
  const page = await client.readTranscript({ afterSequence: input.afterSequence,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.throughSequence === undefined ? {} : { throughSequence: input.throughSequence }),
  });
  const kind = input.breakoutId && input.breakoutId !== "0" ? "Breakout" : "Thread";
  const continuation = page.nextAfterSequence === null ? "" :
    `\n\nMore history: call again with afterSequence=${page.nextAfterSequence} and throughSequence=${page.throughSequence}.`;
  return { text: `${kind}: ${page.title}\n\n${page.text || "No messages."}${continuation}` };
}
