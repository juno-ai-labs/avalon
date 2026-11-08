import type { ConnectorConnectionCardInput } from '@rally/contracts';

import type { ElicitationData, Message } from './types';

export type ElicitationAnswer = string | string[] | null;
type MessageUpdater = (update: (messages: Message[]) => Message[]) => void;

interface ElicitationSource {
  id: string;
  prompt: string;
  responseType: ElicitationData['responseType'] | 'free_text';
  options?: ReadonlyArray<{ label: string; value: string; description?: string | null }>;
  minimumSelections?: number;
  maximumSelections?: number | null;
  allowOther?: boolean;
  targetUserId?: string | null;
  status?: 'open' | 'answered' | 'cancelled';
  answer?: unknown;
  createdAt?: string;
  connection?: ConnectorConnectionCardInput;
}

export function elicitationMessageId(elicitationId: string): string {
  return `elicitation-${elicitationId}`;
}

export function normalizeElicitation(source: ElicitationSource): ElicitationData {
  return {
    id: source.id,
    prompt: source.prompt,
    responseType: source.responseType === 'free_text' ? 'text' : source.responseType,
    ...(source.options ? {
      options: source.options.map((option) => ({
        label: option.label,
        value: option.value,
        ...(option.description ? { description: option.description } : {}),
      })),
    } : {}),
    ...(source.minimumSelections === undefined ? {} : { minimumSelections: source.minimumSelections }),
    ...(source.maximumSelections == null ? {} : { maximumSelections: source.maximumSelections }),
    ...(source.allowOther === undefined ? {} : { allowOther: source.allowOther }),
    ...(source.targetUserId ? { targetUserId: source.targetUserId } : {}),
    status: source.status === 'cancelled' ? 'cancelled'
      : source.status === undefined || source.status === 'open' ? 'open' : 'answered',
    ...(source.answer === undefined ? {} : { answer: source.answer }),
    ...(source.createdAt ? { createdAt: source.createdAt } : {}),
    ...(source.connection ? { connection: source.connection } : {}),
  };
}

export function resolveElicitationMessages(
  messages: Message[],
  elicitationId: string,
  answer: ElicitationAnswer,
): Message[] {
  return messages.map((message) =>
    message.messageType === 'elicitation' && message.elicitation?.id === elicitationId
      ? { ...message, elicitation: { ...message.elicitation, status: 'answered', answer } }
      : message);
}

export async function answerElicitationOptimistically<Result>({
  answer,
  elicitationId,
  previousMessage,
  submit,
  updateMessages,
}: {
  answer: ElicitationAnswer;
  elicitationId: string;
  previousMessage?: Message;
  submit: () => Promise<Result>;
  updateMessages: MessageUpdater;
}): Promise<Result> {
  updateMessages((messages) => resolveElicitationMessages(messages, elicitationId, answer));

  try {
    return await submit();
  } catch (error) {
    if (previousMessage) {
      updateMessages((messages) => messages.map((message) =>
        message.id === previousMessage.id ? previousMessage : message));
    }
    throw error;
  }
}
