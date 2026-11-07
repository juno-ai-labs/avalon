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
  humanMentions: string[];
  addressesRally: boolean;
  recentMessages?: AddressingContextMessage[];
}

const MAX_RECENT_MESSAGES = 10;
const MAX_RECENT_MESSAGE_CHARACTERS = 1_000;

// "collaborative workstream" is the classifier's old wording, kept byte for
// byte: the addressing eval's baselines and the golden hash were measured on
// this prompt, and rewording it is a classifier change to re-measure, not copy.
const SYSTEM_PROMPT = `Classify whether Rally should act on the newest human message in a collaborative workstream.

Outcomes:
- agent_action: asks Rally to answer, investigate, create, change, retrieve, or otherwise work.
- human_only: social, status, or coordination intended only for people; no request for Rally.
- both: requests Rally's work and includes human coordination.
- uncertain: may continue active work, but evidence is insufficient.

Determine who is expected to act - or answer a question. humanMentions lists people appearing as @Name. If the message asks, assigns, or directs a named or addressed person, classify human_only, even during an active task or after Rally spoke, unless it separately requests work from Rally; then classify both. Mentioning a person never cancels a request to Rally.

A connector mention strongly favors agent_action. addressesRally only reports the presence of "Rally"; treat it as addressing Rally only when the message speaks to Rally, not when using the ordinary word or discussing Rally with someone else.

Active-task state is context, not permission to act. Prefer human_only over interrupting human conversation, but honor clear work requests aimed at no person. Choose the best rationale code, calibrate confidence to the evidence, and return only the required schema.`;

export function renderAddressingMessages(input: AddressingPromptInput): PromptMessage[] {
  const recentMessages = limitAddressingRecentMessages(input.recentMessages ?? []);
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: JSON.stringify({
        activeTask: input.activeTask,
        connectorMentions: input.connectorMentions,
        humanMentions: input.humanMentions,
        addressesRally: input.addressesRally,
        recentMessages,
        currentMessage: input.message,
      }),
    },
  ];
}

export function limitAddressingRecentMessages(
  messages: AddressingContextMessage[],
): AddressingContextMessage[] {
  return messages
    .slice(-MAX_RECENT_MESSAGES)
    .map((message) => ({
      authorType: message.authorType,
      authorName: message.authorName,
      message: centerTruncateRecentMessage(message.message),
    }));
}

function centerTruncateRecentMessage(value: string): string {
  const characters = Array.from(value);
  if (characters.length <= MAX_RECENT_MESSAGE_CHARACTERS) return value;

  const retainedCharacters = MAX_RECENT_MESSAGE_CHARACTERS - 1;
  const prefixLength = Math.ceil(retainedCharacters / 2);
  const suffixLength = retainedCharacters - prefixLength;
  return `${characters.slice(0, prefixLength).join("")}…${characters.slice(characters.length - suffixLength).join("")}`;
}
