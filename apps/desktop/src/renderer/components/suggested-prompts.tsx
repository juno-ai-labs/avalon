import type { AutomationPluginIcon } from '@rally/contracts';
import type { ComponentType, ReactNode } from 'react';

import { ConnectorIcon, Icon } from './ui';

/**
 * A suggestion is either attributed to a connector or it is the recency one,
 * so the vocabulary is the connector list plus `clock`. It was a hand-written
 * union that repeated all nine connector names beside an identical copy of the
 * icon map in `workstream-blocks.tsx`; the two drifted the moment one of them
 * gained a provider.
 */
export type SuggestedPromptIcon = AutomationPluginIcon | 'clock';

export interface SuggestedPromptItem {
  id: string;
  text: string;
  icon: SuggestedPromptIcon;
  sourceLabel?: string;
}

export interface SuggestedPromptListProps {
  items: SuggestedPromptItem[];
  label?: string;
  pendingId?: string | null;
  error?: ReactNode;
  onSelect: (item: SuggestedPromptItem) => void;
  onDismiss?: (item: SuggestedPromptItem) => void;
}

function PromptIcon({ icon }: { icon: SuggestedPromptIcon }): React.JSX.Element {
  if (icon === 'clock') return <Icon name="clock" size="xs" />;
  return <ConnectorIcon name={icon} plain />;
}

export function SuggestedPromptList({
  items,
  label,
  pendingId,
  error,
  onSelect,
  onDismiss,
}: SuggestedPromptListProps): React.JSX.Element | null {
  if (items.length === 0 && !error) return null;
  return (
    <section aria-label={label ?? 'Suggested prompts'} className="suggested-prompt-list">
      {label && <h2>{label}</h2>}
      {items.map((item) => {
        const pending = pendingId === item.id;
        return (
          <div className="suggested-prompt-row" key={item.id}>
            <button aria-label={item.text} disabled={Boolean(pendingId)} onClick={() => onSelect(item)} type="button">
              {pending ? <Icon name="spinner" size="xs" spinning /> : <PromptIcon icon={item.icon} />}
              <span>{item.text}</span>
              {item.sourceLabel && <small>{item.sourceLabel}</small>}
              <Icon name="chevron-right" size="xs" />
            </button>
            {onDismiss && (
              <button
                aria-label={`Dismiss ${item.text}`}
                className="suggested-prompt-dismiss"
                disabled={Boolean(pendingId)}
                onClick={() => onDismiss(item)}
                type="button"
              >
                <Icon name="close" size="xs" />
              </button>
            )}
          </div>
        );
      })}
      {error && <p className="suggested-prompt-error">{error}</p>}
    </section>
  );
}

export function withSuggestedPrompts<Props>(
  useAdapter: (props: Props) => SuggestedPromptListProps,
): ComponentType<Props> {
  return function SuggestedPrompts(props: Props): React.JSX.Element | null {
    return <SuggestedPromptList {...useAdapter(props)} />;
  };
}
