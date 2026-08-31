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
// The message being classified gets more room than a history entry, and keeps
// both ends: an opening address ("@Adam, …") sits at the head while a trailing
// ask ("…can you take this?") sits at the tail, and either alone can decide
// the classification.
const MAX_CURRENT_MESSAGE_HEAD_CHARACTERS = 3_000;
const MAX_CURRENT_MESSAGE_TAIL_CHARACTERS = 1_000;

const SYSTEM_PROMPT = `A workstream is a shared conversation between human teammates and an AI Agent Rally. People in it talk to each other and to Rally in the same feed. Classify whether Rally should act on the newest human message.

Outcomes:
- agent_action: asks Rally to answer, investigate, create, change, retrieve, or otherwise work.
- human_only: social, status, or coordination intended only for people; no request for Rally.
- both: requests Rally's work and includes human coordination.
- uncertain: may continue active work, but evidence is insufficient.

Determine who is expected to act - or answer a question. humanMentions lists people appearing as @Name; in recentMessages a mention appears as [@Name](person://<id>), and both forms name a person. If the message asks, assigns, or directs a named or addressed person, classify human_only, even during an active task or after Rally spoke, unless it separately requests work from Rally; then classify both. Mentioning a person never cancels a request to Rally.

A connector mention strongly favors agent_action. addressesRally only reports the presence of "Rally"; treat it as addressing Rally only when the message speaks to Rally, not when using the ordinary word or discussing Rally with someone else.

Active-task state is context, not permission to act. Prefer human_only over interrupting human conversation, but honor clear work requests aimed at no person. Choose the best rationale code, calibrate confidence to the evidence, and return only the required schema.`;

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
        humanMentions: input.humanMentions,
        addressesRally: input.addressesRally,
        recentMessages,
        currentMessage: truncateCenter(
          input.message,
          MAX_CURRENT_MESSAGE_HEAD_CHARACTERS,
          MAX_CURRENT_MESSAGE_TAIL_CHARACTERS,
        ),
      }),
    },
  ];
}

function truncateCharacters(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return Array.from(value).slice(0, maximum).join("");
}

function truncateCenter(value: string, headMaximum: number, tailMaximum: number): string {
  if (value.length <= headMaximum + tailMaximum) return value;
  const points = Array.from(value);
  if (points.length <= headMaximum + tailMaximum) return value;
  return [
    points.slice(0, headMaximum).join(""),
    "[… middle truncated …]",
    points.slice(points.length - tailMaximum).join(""),
  ].join("\n");
}
