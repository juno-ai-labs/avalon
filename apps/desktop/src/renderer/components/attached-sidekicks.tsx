import type { SidekickAttachment } from '@rally/contracts';
import { desktopBridge } from '../lib/platform';
import { InlineError } from './primitives';

export function AttachedSidekicks({ items, error, onRemove }: { items?: SidekickAttachment[] | undefined; error?: string | undefined; onRemove?: ((id: string) => void) | undefined }): React.JSX.Element | null {
  if (error) return <InlineError>{error}</InlineError>;
  if (!items?.length) return null;
  return <section className="workstream-context-section sidekick-attachments"><h2>Sidekicks</h2>
    <ul className="sidekick-attachments-list">{items.map((item) => <li key={item.id}>
      <button className="workstream-context-row" type="button" aria-label={item.name} title={item.description} onClick={() => void desktopBridge().openSidekicks(item.id)}><span className="workstream-context-copy"><span>{item.name}</span><small>{item.description}</small></span></button>
      {!item.available && <small>Unavailable</small>}
      {onRemove && <button className="sidekick-attachment-remove" type="button" aria-label={`Remove ${item.name}`} onClick={() => onRemove(item.id)}>Remove</button>}
    </li>)}</ul>
  </section>;
}
