import { Button, DropdownSelect, type DropdownOption } from './primitives';
export interface MessageCardView {
  id: string;
  participant: string;
  destination: string;
  text: string;
  state: 'draft' | 'sending' | 'sent' | 'failed' | 'unknown';
  canSend: boolean;
  participantLabel?: string | undefined;
  destinationLabel?: string | undefined;
}
const statusCopy = {
  draft: '', sending: 'Sending…', sent: 'Sent',
  failed: 'Message was not accepted. Create a new card to try again.',
  unknown: 'No confirmation received. Retry the same message to avoid a duplicate.',
};
/** Presentation only. The host owns payloads, authority, and attempt identity. */
export function MessageCardStack({ cards, participants, destinations, onEdit, onSend, onRemove, onAdd }: {
  cards: MessageCardView[];
  participants: DropdownOption[];
  destinations: (id: string) => DropdownOption[];
  onEdit: (id: string, patch: Partial<Pick<MessageCardView, 'participant' | 'destination' | 'text'>>) => void;
  onSend: (id: string) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
}): React.JSX.Element {
  return <div className="message-card-stack">
    {cards.map((card, index) => <section className="message-draft-card" aria-label={`Message ${index + 1}`} key={card.id}>
      <div className="message-draft-card-heading"><strong>Message {index + 1}</strong>
        {card.state === 'draft' && <Button className="button-ghost" onClick={() => onRemove(card.id)} aria-label={`Remove message ${index + 1}`}>Remove</Button>}
      </div>
      <div className="message-draft-card-fields">
        <label className="form-field"><span>Participant</span>{card.state !== 'draft' ? <strong>{card.participantLabel ?? card.participant}</strong> : <DropdownSelect ariaLabel={`Participant for message ${index + 1}`} value={card.participant}
          disabled={card.state !== 'draft'} options={[{ value: 'unselected', label: 'Choose participant' }, ...participants]}
          onValueChange={participant => onEdit(card.id, { participant })} />}</label>
        <label className="form-field"><span>Destination</span>{card.state !== 'draft' ? <strong>{card.destinationLabel ?? card.destination}</strong> : <DropdownSelect ariaLabel={`Destination for message ${index + 1}`} value={card.destination}
          disabled={card.state !== 'draft' || !destinations(card.id).length} options={[{ value: 'unselected', label: 'Choose Channel or Breakout' }, ...destinations(card.id)]}
          onValueChange={destination => onEdit(card.id, { destination })} />}</label>
        <label className="form-field"><span>Message</span><textarea aria-label={`Text for message ${index + 1}`} rows={4} value={card.text}
          placeholder="Write a participant message…" readOnly={card.state !== 'draft'} onChange={event => onEdit(card.id, { text: event.target.value })} /></label>
      </div>
      <div className="message-draft-card-footer">
        <span role="status">{statusCopy[card.state]}</span>
        {(card.state === 'draft' || card.state === 'unknown' || card.state === 'sending') && <Button disabled={!card.canSend || card.state === 'sending'} onClick={() => onSend(card.id)}>
          {card.state === 'unknown' ? 'Retry same message' : card.state === 'sending' ? 'Sending…' : 'Send message'}
        </Button>}
      </div>
    </section>)}
    <Button className="button-secondary" onClick={onAdd}>New message</Button>
  </div>;
}
