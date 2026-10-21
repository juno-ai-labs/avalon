import { ErrorNotice } from './primitives';
import {
  IconBrandGithub,
  IconBrandGoogle,
  IconBrandGoogleDrive,
  IconBrandNotion,
  IconBrandSlack,
  IconClock,
  IconPlug,
  IconStack2,
  IconWebhook,
  IconWorldSearch,
  type TablerIcon,
} from '@tabler/icons-react';
import { ChevronRight, LoaderCircle, X } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';

export type SuggestedPromptIcon =
  | 'clock'
  | 'brand-github'
  | 'brand-google'
  | 'brand-google-drive'
  | 'brand-notion'
  | 'brand-slack'
  | 'linear'
  | 'plug'
  | 'webhook'
  | 'world-search';

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

const promptIconByKey: Record<SuggestedPromptIcon, TablerIcon> = {
  clock: IconClock,
  'brand-github': IconBrandGithub,
  'brand-google': IconBrandGoogle,
  'brand-google-drive': IconBrandGoogleDrive,
  'brand-notion': IconBrandNotion,
  'brand-slack': IconBrandSlack,
  linear: IconStack2,
  plug: IconPlug,
  webhook: IconWebhook,
  'world-search': IconWorldSearch,
};

function PromptIcon({ icon }: { icon: SuggestedPromptIcon }): React.JSX.Element {
  const Icon = promptIconByKey[icon];
  return <Icon aria-hidden="true" size={13} />;
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
              {pending ? <LoaderCircle aria-hidden="true" className="spin" size={13} /> : <PromptIcon icon={item.icon} />}
              <span>{item.text}</span>
              {item.sourceLabel && <small>{item.sourceLabel}</small>}
              <ChevronRight aria-hidden="true" size={13} />
            </button>
            {onDismiss && (
              <button
                aria-label={`Dismiss ${item.text}`}
                className="suggested-prompt-dismiss"
                disabled={Boolean(pendingId)}
                onClick={() => onDismiss(item)}
                type="button"
              >
                <X aria-hidden="true" size={12} />
              </button>
            )}
          </div>
        );
      })}
      {error && <ErrorNotice>{error}</ErrorNotice>}
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
