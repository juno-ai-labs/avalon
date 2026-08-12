import type { ElicitationData, Message, ToolEventData } from './types';

type TextMessageInput = Omit<Message, 'messageType' | 'text'> & { text: string };
type ToolEventMessageInput = Omit<Message, 'messageType' | 'toolEvent'> & { toolEvent: ToolEventData };
type ElicitationMessageInput = Omit<Message, 'messageType' | 'elicitation'> & { elicitation: ElicitationData };

export function dismissedSuggestionIdsQueryKey(workstreamId: string): readonly ['dismissed-suggestion-ids', string] {
  return ['dismissed-suggestion-ids', workstreamId];
}

export function appendDismissedSuggestionId(
  current: readonly string[] | undefined,
  suggestionId: string,
): readonly string[] {
  return current?.includes(suggestionId) ? current : [...(current ?? []), suggestionId];
}

export function visibleTranscriptMessages(
  messages: Message[],
  dismissedSuggestionIds: readonly string[] = [],
): Message[] {
  const dismissed = new Set(dismissedSuggestionIds);
  return messages.filter((message) => !(
    message.messageType === 'activity_suggestion'
    && message.activitySuggestion
    && (message.activitySuggestion.status === 'dismissed' || dismissed.has(message.activitySuggestion.id))
  ));
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
