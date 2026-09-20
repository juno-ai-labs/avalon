import { useEffect, useRef, useState } from 'react';
import { asSubstreamId } from '@rally/contracts';
import { DemoMessageRequestSchema, type DemoCatalog } from '@rally/contracts/demo-sidecar';
import { MessageCardStack } from '@rally/ui/components/message-card-stack';
import { Button } from '@rally/ui/components/primitives';
import type { DemoSidecarBridge } from '../../common/demo-sidecar';
import { beginSend, createCard, editCard, finishSend, type MessageCard } from '../../common/demo-cards';

export function DemoSidecarScreen({ bridge }: { bridge: DemoSidecarBridge }): React.JSX.Element {
  const [catalog, setCatalog] = useState<DemoCatalog | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'denied' | 'offline' | 'failed'>('loading');
  const [cards, setCards] = useState<MessageCard[]>(() => [createCard()]);
  // Synchronous ownership prevents two click events submitting one card twice.
  const liveCards = useRef(cards);
  const replace = (next: MessageCard[]): void => { liveCards.current = next; setCards(next); };
  const reload = async (): Promise<void> => {
    setState('loading');
    const result = await bridge.catalog().catch(() => ({ ok: false as const, kind: 'unknown' as const }));
    if (!result.ok) { setCatalog(null); setState(result.kind === 'unknown' ? 'offline' : result.kind); return; }
    setCatalog(result.data);
    replace(liveCards.current.map(card => {
      if (card.status !== 'draft') return card;
      const participant = result.data.participants.find(person => person.userId === card.representedUserId);
      if (!participant) return { ...card, representedUserId: '', workstreamId: '', substreamId: asSubstreamId('0') };
      if (!participant.destinations.some(destination => destination.workstreamId === card.workstreamId && destination.substreamId === card.substreamId)) return { ...card, workstreamId: '', substreamId: asSubstreamId('0') };
      return card;
    }));
    setState('ready');
  };
  useEffect(() => { void reload(); }, [bridge]); // No polling, sockets, or focus refetch.
  const send = async (id: string): Promise<void> => {
    const card = liveCards.current.find(item => item.id === id);
    if (!card || (card.status !== 'draft' && card.status !== 'unknown') || state !== 'ready') return;
    const participant = catalog?.participants.find(person => person.userId === card.representedUserId);
    const destination = participant?.destinations.find(item => item.workstreamId === card.workstreamId && item.substreamId === card.substreamId);
    if (card.status === 'draft' && (!participant || !destination)) return;
    const sending = beginSend({ ...card, participantLabel: card.participantLabel ?? participant?.name ?? 'Participant',
      destinationLabel: card.destinationLabel ?? destination?.label ?? 'Destination' });
    if (!DemoMessageRequestSchema.safeParse(sending.payload).success || !sending.payload) return;
    replace(liveCards.current.map(item => item.id === id ? sending : item));
    const response = await bridge.send(sending.payload).catch(() => ({ ok: false as const, kind: 'unknown' as const }));
    replace(liveCards.current.map(item => item.id === id ? finishSend(item, response.ok ? { kind: 'sent', turnId: response.data.turnId }
      : { kind: response.kind === 'unknown' ? 'unknown' : 'failed', message: response.kind }) : item));
    if (!response.ok && response.kind === 'denied') { setState('denied'); setCatalog(null); }
  };
  return <main className="compact-tool-shell">
    <header><h1>Demo sidecar</h1><span className="tool-marker">Impersonation</span>
      {catalog && <p>{catalog.workspaceName} · {catalog.operatorName}</p>}
      <p>Represented messages are audited.</p>
    </header>
    {state !== 'ready' ? <section role="status"><p>{state === 'loading' ? 'Loading participants and destinations…'
      : state === 'denied' ? 'Demo sidecar is unavailable for this account or organization.'
        : state === 'offline' ? 'Cannot reach Rally. Check your connection and try again.' : 'Could not load this demo. Try again.'}</p>
      {state !== 'loading' && <Button onClick={() => void reload()}>Try again</Button>}
    </section> : <>
      {!catalog?.participants.length && <p>No participants are available for represented messages.</p>}
      <MessageCardStack cards={cards.map(card => ({ id: card.id, participant: card.representedUserId || 'unselected',
        destination: card.workstreamId ? JSON.stringify([card.workstreamId, card.substreamId]) : 'unselected', text: card.text, state: card.status,
        participantLabel: card.participantLabel, destinationLabel: card.destinationLabel,
        canSend: (card.status === 'unknown' || card.status === 'draft') && DemoMessageRequestSchema.safeParse({ representedUserId: card.representedUserId,
          workstreamId: card.workstreamId, substreamId: card.substreamId, text: card.text, clientMessageId: card.id }).success,
      }))} participants={catalog?.participants.map(person => ({ value: person.userId, label: person.name })) ?? []}
        destinations={id => catalog?.participants.find(person => person.userId === cards.find(card => card.id === id)?.representedUserId)?.destinations.map(destination => ({ value: JSON.stringify([destination.workstreamId, destination.substreamId]), label: destination.label })) ?? []}
        onEdit={(id, patch) => replace(liveCards.current.map(card => {
          if (card.id !== id) return card;
          if (patch.participant !== undefined) return editCard(card, { representedUserId: patch.participant === 'unselected' ? '' : patch.participant });
          if (patch.destination !== undefined) {
            const destination = catalog?.participants.find(person => person.userId === card.representedUserId)?.destinations.find(item => JSON.stringify([item.workstreamId, item.substreamId]) === patch.destination);
            return editCard(card, { workstreamId: destination?.workstreamId ?? '', substreamId: destination?.substreamId ?? asSubstreamId('0') });
          }
          return patch.text === undefined ? card : editCard(card, { text: patch.text });
        }))} onSend={id => void send(id)} onRemove={id => replace(liveCards.current.filter(card => card.id !== id || card.status !== 'draft'))}
        onAdd={() => {
          const previous = liveCards.current.at(-1);
          const participant = catalog?.participants.find(person => person.userId === previous?.representedUserId);
          const destination = participant?.destinations.find(item => item.workstreamId === previous?.workstreamId && item.substreamId === previous?.substreamId);
          replace([...liveCards.current, createCard(participant && destination ? previous : undefined)]);
        }} />
      <p><Button className="button-ghost" onClick={() => void reload()}>Refresh participants and destinations</Button></p>
    </>}
  </main>;
}
