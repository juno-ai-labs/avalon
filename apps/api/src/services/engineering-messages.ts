import { CreateMessageRequestSchema } from "@rally/contracts";
import { rewriteMessageAsPlainText } from "@rally/contracts/citations";
import type {
  EngineeringTextResult, ReadEngineeringChannelInput, ReadEngineeringConversationInput,
  SendEngineeringMessageInput, SendEngineeringMessageResult,
  ListEngineeringUserChannelsInput, ListEngineeringUserConversationsInput,
} from "@rally/contracts/engineering-inspection";

import type { Env } from "../env";
import { engineeringUserAuth } from "./engineering-creation";
import { ConversationService } from "./conversation-service";
import { SpaceService } from "./space-service";
import { conversationAsText } from "./engineering-conversation-text";

export async function listEngineeringUserChannels(env: Env, input: ListEngineeringUserChannelsInput) {
  const auth = await engineeringUserAuth(env, input.orgId, input.userId);
  return new SpaceService(env, auth).list();
}

export async function listEngineeringUserConversations(env: Env, input: ListEngineeringUserConversationsInput) {
  const auth = await engineeringUserAuth(env, input.orgId, input.userId);
  return new SpaceService(env, auth).listChannels(input.channelId, input.cursor ?? null, {
    kind: input.kind, needsViewerOnly: false,
  });
}

export async function sendEngineeringMessage(env: Env, input: SendEngineeringMessageInput): Promise<SendEngineeringMessageResult> {
  const message = CreateMessageRequestSchema.parse({ ...input, clientMessageId: input.operationId });
  const auth = await engineeringUserAuth(env, input.orgId, input.userId, input.operationId);
  const client = await new ConversationService(env, auth).writableClient(input.threadId, input.breakoutId ?? "0");
  const receipt = await client.createMessage(message);
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
  return { text: `${kind}: ${page.title}\n\n${conversationAsText(page.range.turns) || "No messages."}${continuation}` };
}

export async function readEngineeringChannel(env: Env, input: ReadEngineeringChannelInput): Promise<EngineeringTextResult> {
  const auth = await engineeringUserAuth(env, input.orgId, input.userId);
  const spaces = new SpaceService(env, auth);
  const [channel, page] = await Promise.all([
    spaces.summary(input.channelId), spaces.listFeed(input.channelId, input.cursor ?? null),
  ]);
  const authorIds = [...new Set(page.items.flatMap((item) => item.kind === "message" && item.message.author.kind === "member"
    ? [item.message.author.userId] : []))];
  const profiles = authorIds.length === 0 ? [] : await env.DB.batch<{ name: string }>(authorIds.map((id) =>
    env.DB.prepare("SELECT name FROM users WHERE id = ?").bind(id)));
  const names = new Map(authorIds.map((id, index) => [id, profiles[index]?.results[0]?.name]));
  const items = page.items.slice().reverse().map((item) => {
    if (item.kind === "thread") return `Thread: ${item.thread.title}\n${rewriteMessageAsPlainText(item.thread.objective)}`;
    const author = item.message.author.kind === "rally" ? "Rally" : names.get(item.message.author.userId) ?? "Participant";
    return `${author} · ${item.placedAt}\n${rewriteMessageAsPlainText(item.message.body)}`;
  });
  const continuation = page.nextCursor === null ? "" : `\n\nOlder Channel history: call again with cursor=${page.nextCursor}.`;
  return { text: `Channel: ${channel.name}\n\n${items.join("\n\n") || "No messages or threads."}${continuation}` };
}
