import type { ElicitationData, Message, ToolEventData } from './types';

type TextMessageInput = Omit<Message, 'messageType' | 'text'> & { text: string };
type ToolEventMessageInput = Omit<Message, 'messageType' | 'toolEvent'> & { toolEvent: ToolEventData };
type ElicitationMessageInput = Omit<Message, 'messageType' | 'elicitation'> & { elicitation: ElicitationData };

export function visibleTranscriptMessages(messages: Message[]): Message[] {
  return messages.filter((message) => message.messageType !== 'activity_suggestion');
}

/**
 * The agent turns that continue the one above them rather than starting a new
 * one, by id.
 *
 * A run now writes its words in several rows — what it said before each set of
 * tool calls, and what it ended on — so one answer arrives as a column of
 * bubbles rather than as a single one. Repeating "Avalon" and a timestamp over
 * each of them would read as several people answering in turn. The tool and
 * timing rows between them are the run's own work and do not interrupt it;
 * anything else — a person, a question, a note about the work stream — does,
 * and the next thing the agent says starts a new turn.
 */
export function continuedAgentTurns(messages: Message[]): Set<string> {
  const continued = new Set<string>();
  let agentIsSpeaking = false;
  for (const message of messages) {
    if (message.messageType === 'tool_event' || message.messageType === 'thought') continue;
    if (message.messageType === 'text' && message.authorType === 'agent') {
      if (agentIsSpeaking) continued.add(message.id);
      agentIsSpeaking = true;
      continue;
    }
    agentIsSpeaking = false;
  }
  return continued;
}

export function createTextMessage({ text, ...message }: TextMessageInput): Message {
  return { ...message, messageType: 'text', text };
}

export function createToolEventMessage({ toolEvent, ...message }: ToolEventMessageInput): Message {
  return { ...message, messageType: 'tool_event', toolEvent };
}

export function createElicitationMessage({ elicitation, ...message }: ElicitationMessageInput): Message {
  return { ...message, messageType: 'elicitation', elicitation };
}

export function isSameLogicalMessage(left: Message, right: Message): boolean {
  if (left.id === right.id) return true;
  if (left.clientMessageId && (
    left.clientMessageId === right.id
    || left.clientMessageId === right.clientMessageId
  )) return true;
  return Boolean(right.clientMessageId && right.clientMessageId === left.id);
}

function preferLogicalMessage(existing: Message, incoming: Message): Message {
  const existingElicitation = existing.messageType === 'elicitation' ? existing.elicitation : undefined;
  const incomingElicitation = incoming.messageType === 'elicitation' ? incoming.elicitation : undefined;
  if (
    existingElicitation
    && incomingElicitation
    && existingElicitation.id === incomingElicitation.id
    && existingElicitation.status === 'answered'
    && incomingElicitation.status === 'open'
  ) {
    return existing;
  }
  return incoming;
}

export function upsertTranscriptMessage(messages: Message[] | undefined, message: Message): Message[] {
  const existing = messages ?? [];
  const index = existing.findIndex((candidate) => isSameLogicalMessage(candidate, message));
  if (index < 0) return [...existing, message];
  const existingReplacement = existing.slice(index + 1).reduce(
    (preferred, candidate) => isSameLogicalMessage(candidate, message)
      ? preferLogicalMessage(preferred, candidate)
      : preferred,
    existing[index]!,
  );
  const replacement = preferLogicalMessage(existingReplacement, message);
  return [
    ...existing.slice(0, index),
    replacement,
    ...existing.slice(index + 1).filter((candidate) => !isSameLogicalMessage(candidate, message)),
  ];
}

export function removeTranscriptMessage(messages: Message[] | undefined, id: string): Message[] {
  return (messages ?? []).filter((message) => message.id !== id);
}
