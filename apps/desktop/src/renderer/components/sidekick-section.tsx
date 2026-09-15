import type { SidekickAttachment, WorkstreamAppearance } from '@rally/contracts';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { IconCarambola } from '@tabler/icons-react';
import type { WorkstreamAutomationSummary } from '../lib/types';
import { desktopBridge } from '../lib/platform';
import { AutomationGlyph } from './workstream-glyph';
import { InlineError, Tip } from './primitives';

/**
 * One Sidekick as a rail row, whichever list it came from.
 *
 * The row is the primitive; the two lists behind it are not. A work stream's
 * own Sidekicks and the ones loaded into its conversation are different facts
 * about the same object, and a reader looking at the rail wants the object:
 * `workstreamSidekickRows` folds both into this shape, and this component
 * knows nothing about either.
 */
export interface SidekickRow {
  recommended?: boolean;
  id: string;
  name: string;
  description: string;
  /**
   * What is true of this Sidekick beyond its description — `Draft`, `Paused`,
   * `Unavailable`. Read before the description rather than instead of it, so
   * the row still says which Sidekick it is.
   */
  note?: string | undefined;
  appearance?: WorkstreamAppearance | undefined;
  /** Present only where the caller may detach it; a room's own row has none. */
  onRemove?: (() => void) | undefined;
}

/**
 * The rail's **Sidekicks** section, or nothing.
 *
 * Absent while `items` is `undefined` — the answer is still on its way — and
 * absent again for `[]`, which is the rail's settled answer to an empty
 * section: a heading over nothing reads as a load failure, and the artifact
 * section beside this one drops itself for the same reason. The two states are
 * still kept apart in the caller, because only one of them may ever be turned
 * into a claim about the room.
 *
 * An `error` sits *beside* the rows rather than replacing them. The rows it
 * would replace are ones that arrived: a detach that failed is no reason for
 * the Sidekicks it did not detach to disappear, and a failed read of one of
 * the two lists behind this section is no reason to drop the other. Alone —
 * nothing arrived — it takes the section's heading with it, because then the
 * reader is being told about this section rather than about a row in it.
 */
export function SidekickSection({ items, error }: {
  items?: SidekickRow[] | undefined;
  error?: string | undefined;
}): React.JSX.Element | null {
  if (!items?.length) {
    return error
      ? <section aria-label="Sidekicks" className="workstream-context-section sidekick-section"><h2>Sidekicks</h2>
        <InlineError>{error}</InlineError>
      </section>
      : null;
  }
  return <section aria-label="Sidekicks" className="workstream-context-section sidekick-section"><h2>Sidekicks</h2>
    {error && <InlineError>{error}</InlineError>}
    <ul className="sidekick-section-list">{items.map((item) => <ContextMenu.Root key={item.id}><li>
      {/* The rail's own tooltip rather than the platform's, as the artifact
          rows above take it: a name this rail truncates — or hides outright
          when compact — is the whole reason the row carries one. The note
          rides along because compact hides the copy underneath, and a row
          nobody can read is the one place **Paused** is worth saying twice. */}
      <Tip label={item.note ? `${item.name} · ${item.note}` : item.name} side="right">
        <ContextMenu.Trigger asChild disabled={!item.onRemove}>
        <button className="workstream-context-row" type="button" aria-label={item.name} aria-description={item.recommended ? 'Recommended Sidekick' : undefined} onClick={() => void desktopBridge().openSidekicks(item.id)}>
          {/* The library's own hexagon, at the rail's size: compact drops every
              title in this rail, and a Sidekick row without its mark collapses
              to an empty square there. */}
          <span aria-hidden="true" className="workstream-context-mark"><span className="workstream-context-sidekick-glyph">
            <AutomationGlyph id={item.id} {...(item.appearance ? { appearance: item.appearance } : {})} />
          </span></span>
          <span className="workstream-context-copy"><span>{item.name}</span>
            <small>{item.note ? `${item.note} · ${item.description}` : item.description}</small></span>
        </button>
        </ContextMenu.Trigger>
      </Tip>
      {item.recommended && <Tip className="sidekick-recommendation-tooltip" label="Recommended for every substream in this workstream. Agents can load it when relevant; it isn’t automatically loaded." side="right">
        <span className="sidekick-recommendation" role="img" aria-label="Recommended Sidekick" tabIndex={0}>
          <IconCarambola size={14} stroke={1.5} aria-hidden="true" />
        </span>
      </Tip>}
      {item.onRemove && <ContextMenu.Portal>
        <ContextMenu.Content className="menu-content">
          <ContextMenu.Item className="menu-item" onSelect={item.onRemove}>Remove</ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>}
    </li></ContextMenu.Root>)}</ul>
  </section>;
}

/** A lifecycle worth saying out loud; an active Sidekick needs no note. */
function ownedNote(status: WorkstreamAutomationSummary['status']): string | undefined {
  return status === 'draft' ? 'Draft' : status === 'paused' ? 'Paused' : undefined;
}

/**
 * The Sidekicks of one work stream: the ones it owns, then the ones its
 * conversation has loaded.
 *
 * Owned first because those are the room's — created here, managed by its
 * participants, and listed nowhere else in the product. The union is keyed by
 * id rather than concatenated: a room's own loadable Sidekick that has been
 * loaded in the main conversation is in both answers, and it is one Sidekick.
 * Where it is in both, the owned summary supplies the row — it carries the
 * chosen appearance and the live lifecycle, which an attachment does not — and
 * the attachment supplies the removal, which is the one thing only it can say.
 *
 * `undefined` until both answers are in, for the reason `SidekickSection`
 * separates the two states: a half-answered union rendered as `[]` is a claim
 * that the room has no Sidekicks.
 */
export function workstreamSidekickRows({ owned, attached, recommended = [], onRemoveAttachment, onRemoveRecommendation }: {
  owned: WorkstreamAutomationSummary[] | undefined;
  attached: SidekickAttachment[] | undefined;
  recommended?: SidekickAttachment[] | undefined;
  onRemoveAttachment?: ((id: string) => void) | undefined;
  onRemoveRecommendation?: ((id: string) => void) | undefined;
}): SidekickRow[] | undefined {
  if (!owned || !attached) return undefined;
  const attachments = new Map(attached.map((attachment) => [attachment.id, attachment]));
  const rows: SidekickRow[] = owned.map((sidekick) => {
    const attachment = attachments.get(sidekick.id);
    // Lifecycle first, because that is the owned summary's to state; then the
    // attachment's own answer, which is the other direction of the rule above.
    // An `active` Sidekick can still be an unavailable attachment — publishing
    // a triggered revision over an instruction-only one clears `loadable`
    // while the room's conversation keeps the attachment — and the row would
    // otherwise say nothing about a Sidekick its next run will not load.
    const note = ownedNote(sidekick.status) ?? (attachment && !attachment.available ? 'Unavailable' : undefined);
    return {
      id: sidekick.id,
      recommended: true,
      name: sidekick.name,
      description: sidekick.description,
      ...(sidekick.appearance ? { appearance: sidekick.appearance } : {}),
      ...(note ? { note } : {}),
      ...(attachment && onRemoveAttachment
        ? { onRemove: () => onRemoveAttachment(sidekick.id) }
        : {}),
    };
  });
  const ownedIds = new Set(owned.map((sidekick) => sidekick.id));
  for (const attachment of attached) {
    if (ownedIds.has(attachment.id)) continue;
    rows.push({
      id: attachment.id,
      name: attachment.name,
      description: attachment.description,
      ...(attachment.available ? {} : { note: 'Unavailable' }),
      ...(onRemoveAttachment ? { onRemove: () => onRemoveAttachment(attachment.id) } : {}),
    });
  }
  for (const recommendation of recommended) {
    const existing = rows.find((row) => row.id === recommendation.id);
    if (existing) {
      existing.recommended = true;
      if (onRemoveRecommendation && !ownedIds.has(recommendation.id)) existing.onRemove = () => onRemoveRecommendation(recommendation.id);
    }
    else rows.push({ id: recommendation.id, name: recommendation.name, description: recommendation.description,
      recommended: true, ...(recommendation.available ? {} : { note: 'Unavailable' }),
      ...(onRemoveRecommendation ? { onRemove: () => onRemoveRecommendation(recommendation.id) } : {}),
    });
  }
  return rows;
}
