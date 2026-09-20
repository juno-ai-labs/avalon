import { asSubstreamId } from '@rally/contracts';
import type { DemoMessageRequest } from '@rally/contracts/demo-sidecar';

export type CardOutcome = { kind: 'sent'; turnId: string } | { kind: 'failed' | 'unknown'; message: string };
export type MessageCard = Omit<DemoMessageRequest, 'clientMessageId'> & {
  id: string;
  status: 'draft' | 'sending' | CardOutcome['kind'];
  payload?: DemoMessageRequest;
  outcome?: CardOutcome;
  participantLabel?: string;
  destinationLabel?: string;
};
export function createCard(previous?: MessageCard): MessageCard {
  return { id: crypto.randomUUID(), status: 'draft', representedUserId: previous?.representedUserId ?? '',
    workstreamId: previous?.workstreamId ?? '', substreamId: previous?.substreamId ?? asSubstreamId('0'), text: '' };
}
export function editCard(card: MessageCard, patch: Partial<Pick<MessageCard, 'representedUserId' | 'workstreamId' | 'substreamId' | 'text'>>): MessageCard {
  if (card.status !== 'draft') return card;
  const changed = patch.representedUserId !== undefined && patch.representedUserId !== card.representedUserId;
  return { ...card, ...patch, ...(changed && patch.workstreamId === undefined ? { workstreamId: '', substreamId: asSubstreamId('0') } : {}) };
}
export function beginSend(card: MessageCard): MessageCard {
  if (card.status === 'sent' || card.status === 'sending' || card.status === 'failed') return card;
  const payload = card.payload ?? { representedUserId: card.representedUserId, workstreamId: card.workstreamId,
    substreamId: card.substreamId, text: card.text, clientMessageId: card.id };
  return { ...card, status: 'sending', payload };
}
export function finishSend(card: MessageCard, outcome: CardOutcome): MessageCard {
  if (card.status !== 'sending') return card;
  return { ...card, status: outcome.kind, outcome };
}
