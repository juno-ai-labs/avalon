import type { PromptMessage } from "./types";

export interface AddressingPromptInput {
  message: string;
  activeTask: boolean;
  connectorMentions: string[];
  addressesAvalon: boolean;
}

const SYSTEM_PROMPT = `Classify whether Avalon, the inherent agent in a collaborative work stream, should act on the newest human message.

Use these outcomes precisely:
- agent_action: the message asks Avalon to answer, investigate, create, change, retrieve, or otherwise do work.
- human_only: the message is social acknowledgement, status-sharing, or coordination intended only for people and contains no request for Avalon.
- both: the message combines a request Avalon should handle with human-to-human coordination or participation.
- uncertain: the message may be a continuation of active work, but there is not enough evidence to decide safely.

An explicit Avalon reference or connector mention strongly indicates agent_action. A question is not automatically mixed: classify it by who is expected to answer. Active-task state is context, not an automatic reason to act. Prefer human_only over interrupting ordinary human conversation, but do not ignore a clear work request. Select the single rationale code that best explains the decision and calibrate confidence to the evidence. Return only the required schema.`;

export function renderAddressingMessages(input: AddressingPromptInput): PromptMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: JSON.stringify({
        message: input.message,
        activeTask: input.activeTask,
        connectorMentions: input.connectorMentions,
        addressesAvalon: input.addressesAvalon,
      }),
    },
  ];
}
