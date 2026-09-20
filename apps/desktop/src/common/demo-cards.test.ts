import { expect, it } from 'vitest';
import { asSubstreamId } from '@rally/contracts';
import { createCard, editCard, beginSend, finishSend } from './demo-cards';

it('freezes a submitted payload and retries the same key after an unknown outcome', () => {
  const draft = editCard(createCard(), { representedUserId: 'person', workstreamId: 'room', substreamId: asSubstreamId('0'), text: 'Hello' });
  const sending = beginSend(draft);
  expect(editCard(sending, { text: 'Changed' })).toEqual(sending);
  expect(beginSend(sending)).toBe(sending);
  const unknown = finishSend(sending, { kind: 'unknown', message: 'No response' });
  const retry = beginSend(unknown);
  expect(retry.payload).toEqual(sending.payload);
  expect(retry.id).toBe(sending.id);
  const sent = finishSend(retry, { kind: 'sent', turnId: 'turn' });
  expect(beginSend(sent)).toBe(sent);
  const next = createCard(sent);
  expect(next.text).toBe('');
  expect(next.id).not.toBe(sent.id);
  expect(next.workstreamId).toBe('room');
});
it('changing participant clears the destination before submission', () => {
  const draft = editCard(createCard(), { representedUserId: 'person', workstreamId: 'room', substreamId: asSubstreamId('00000000-0000-4000-8000-000000000001') });
  expect(editCard(draft, { representedUserId: 'other' })).toMatchObject({ workstreamId: '', substreamId: '0' });
});
