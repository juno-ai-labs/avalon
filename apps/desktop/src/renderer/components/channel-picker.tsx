import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** One place something can be sent: push or email. */
export interface ChannelOption {
  id: string;
  label: string;
  /** What the closed menu says, when the full label is too long for it. */
  shortLabel?: string;
  /** One line under the label in the menu: where it goes. */
  hint: string;
  icon: ReactNode;
}

/**
 * The narrowest the row's own words may get before its options stop fitting
 * beside them. Below this the row shows one menu instead of a button each.
 */
const LABEL_MIN_WIDTH = 200;
/** The row's gap between its words and its control, as `.settings-preference-row` draws it. */
const ROW_GAP = 20;

/**
 * Choose any number of `options` for one row of settings: a toggle button for
 * each while they all fit beside the row's words, and one menu of checkboxes
 * once they do not. The row is measured, not the window, because every row
 * decides for itself.
 */
export function ChannelPicker({ label, options, selected, onToggle, none, disabled = false }: {
  /** Names the group for assistive technology: "How to tell you about mentions". */
  label: string;
  options: readonly ChannelOption[];
  selected: readonly string[];
  onToggle: (id: string) => void;
  /** What the closed menu says when nothing is chosen. */
  none: string;
  disabled?: boolean;
}): React.JSX.Element {
  const holder = useRef<HTMLSpanElement | null>(null);
  const probe = useRef<HTMLSpanElement | null>(null);
  const [inline, setInline] = useState(true);

  useLayoutEffect(() => {
    const row = holder.current?.parentElement;
    if (!row || !probe.current) return;
    const measure = () => {
      if (!probe.current) return;
      const style = getComputedStyle(row);
      const available = row.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      setInline(available - LABEL_MIN_WIDTH - ROW_GAP >= probe.current.scrollWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [options.length]);

  const chips = (interactive: boolean) => options.map((option) => {
    const on = selected.includes(option.id);
    return (
      <button
        aria-pressed={on}
        className="channel-chip"
        disabled={disabled}
        key={option.id}
        onClick={interactive ? () => onToggle(option.id) : undefined}
        tabIndex={interactive ? undefined : -1}
        title={option.hint}
        type="button"
      >
        {option.icon}
        <span>{option.label}</span>
      </button>
    );
  });

  const chosen = options.filter((option) => selected.includes(option.id));
  return (
    <span className="channel-picker" ref={holder}>
      {/* Every button laid out once, unseen, so the row knows what they need. */}
      <span aria-hidden="true" className="channel-chips channel-chips-probe" ref={probe}>{chips(false)}</span>
      {inline
        ? <span aria-label={label} className="channel-chips" role="group">{chips(true)}</span>
        : (
          <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger asChild disabled={disabled}>
              <button aria-label={label} className="channel-menu-trigger" type="button">
                <span>{chosen.length ? joinLabels(chosen.map((option) => option.shortLabel ?? option.label)) : none}</span>
                <ChevronDown aria-hidden="true" size={13} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" className="menu-content channel-menu" collisionPadding={8} sideOffset={4}>
                {options.map((option) => (
                  <DropdownMenu.CheckboxItem
                    checked={selected.includes(option.id)}
                    className="menu-item channel-menu-item"
                    key={option.id}
                    // Stay open: choosing several is the point.
                    onSelect={(event) => {
                      event.preventDefault();
                      onToggle(option.id);
                    }}
                  >
                    <span aria-hidden="true" className="channel-menu-check">
                      <DropdownMenu.ItemIndicator><Check size={11} strokeWidth={3} /></DropdownMenu.ItemIndicator>
                    </span>
                    <span className="channel-menu-copy">
                      <span>{option.label}</span>
                      <small>{option.hint}</small>
                    </span>
                  </DropdownMenu.CheckboxItem>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )}
    </span>
  );
}

/** "Push", "Push and Email", "Push, Email and SMS". */
export function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}
