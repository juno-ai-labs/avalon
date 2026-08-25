import type { PromptMessage } from "./types";

export interface AddressingContextMessage {
  authorType: "human" | "agent";
  authorName: string | null;
  message: string;
}

export interface AddressingPromptInput {
  message: string;
  activeTask: boolean;
  connectorMentions: string[];
  addressesRally: boolean;
  recentMessages?: AddressingContextMessage[];
}

const MAX_RECENT_MESSAGES = 10;
const MAX_RECENT_MESSAGE_CHARACTERS = 1_000;

const SYSTEM_PROMPT = `Classify whether Rally, the inherent agent in a collaborative work stream, should act on the newest human message.

Use these outcomes precisely:
- agent_action: the message asks Rally to answer, investigate, create, change, retrieve, or otherwise do work.
- human_only: the message is social acknowledgement, status-sharing, or coordination intended only for people and contains no request for Rally.
- both: the message combines a request Rally should handle with human-to-human coordination or participation.
- uncertain: the message may be a continuation of active work, but there is not enough evidence to decide safely.

An explicit Rally reference or connector mention strongly indicates agent_action. A question is not automatically mixed: classify it by who is expected to answer. Active-task state is context, not an automatic reason to act. Prefer human_only over interrupting ordinary human conversation, but do not ignore a clear work request. Select the single rationale code that best explains the decision and calibrate confidence to the evidence. Return only the required schema.`;

export function renderAddressingMessages(input: AddressingPromptInput): PromptMessage[] {
  const recentMessages = (input.recentMessages ?? [])
    .slice(-MAX_RECENT_MESSAGES)
    .map((message) => ({
      authorType: message.authorType,
      authorName: message.authorName,
      message: truncateCharacters(message.message, MAX_RECENT_MESSAGE_CHARACTERS),
    }));
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: JSON.stringify({
        activeTask: input.activeTask,
        connectorMentions: input.connectorMentions,
        addressesRally: input.addressesRally,
        recentMessages,
        currentMessage: input.message,
      }),
    },
  ];
}

function truncateCharacters(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return Array.from(value).slice(0, maximum).join("");
}
