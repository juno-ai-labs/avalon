import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { IconBell } from '@tabler/icons-react';
import { forwardRef, useState, type ButtonHTMLAttributes } from 'react';
import { useNavigate } from 'react-router-dom';

import { attentionItemPath, type AttentionItem } from '../lib/attention-items';
import { formatSidebarActivityTime, statusLabel } from '../lib/format';
import { StatusDot, Tip } from './primitives';
import { RelativeTime } from './relative-time';
import { WorkstreamGlyph } from './workstream-glyph';

export const NOTHING_NEEDS_ATTENTION = 'Nothing needs your attention';

function attentionLabel(count: number): string {
  return count === 1 ? '1 conversation needs your attention' : `${count} conversations need your attention`;
}

/**
 * The trigger: a red count while anything is waiting, a bell when nothing is.
 * A plain button so Radix's trigger and the tooltip can both pass it a ref.
 */
const AttentionTrigger = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { count: number }>(
  function AttentionTrigger({ count, ...props }, ref) {
    return <button
      ref={ref}
      aria-label={count > 0 ? attentionLabel(count) : NOTHING_NEEDS_ATTENTION}
      className={count > 0 ? 'icon-button attention-trigger has-attention' : 'icon-button attention-trigger'}
      type="button"
      {...props}
    >
      {count > 0
        ? <span aria-hidden="true" className="attention-count">{count}</span>
        : <IconBell aria-hidden="true" size={16} stroke={1.9} />}
    </button>;
  },
);

/**
 * The sidebar's attention menu: every Channel and Breakout waiting for this
 * reader, each a link to where it is waiting. `docs/attention-menu.md`.
 */
export function AttentionMenu({ items }: { items: readonly AttentionItem[] }): React.JSX.Element {
  const navigate = useNavigate();
  const count = items.length;
  const [open, setOpen] = useState(false);
  // The tip would sit over the menu's first row; it is closed while the menu is open.
  const [tipOpen, setTipOpen] = useState(false);
  return <DropdownMenu.Root onOpenChange={(next) => { setOpen(next); if (next) setTipOpen(false); }} open={open}>
    <Tip
      describesTrigger={false}
      label={count > 0 ? attentionLabel(count) : NOTHING_NEEDS_ATTENTION}
      onOpenChange={(next) => setTipOpen(next && !open)}
      open={tipOpen}
      side="bottom"
    >
      <DropdownMenu.Trigger asChild>
        <AttentionTrigger count={count} />
      </DropdownMenu.Trigger>
    </Tip>
    <DropdownMenu.Portal>
      <DropdownMenu.Content align="start" aria-label="Needs your attention" className="menu-content attention-menu" collisionPadding={8} sideOffset={6}>
        {count === 0
          ? <div className="attention-menu-empty">{NOTHING_NEEDS_ATTENTION}</div>
          : items.map((item) => <DropdownMenu.Item
            className="menu-item attention-menu-item"
            key={item.key}
            onSelect={() => void navigate(attentionItemPath(item))}
          >
            <WorkstreamGlyph appearance={item.appearance} id={item.workstreamId} size={20} />
            <span className="attention-menu-text">
              <span className="attention-menu-title">{item.title}</span>
              <span className="attention-menu-detail">
                {item.channelTitle === null ? statusLabel[item.reason] : `${statusLabel[item.reason]} in ${item.channelTitle}`}
              </span>
            </span>
            <span className="attention-menu-meta">
              <RelativeTime className="attention-menu-time" format={formatSidebarActivityTime} value={item.at} />
              <StatusDot compact status={item.reason} />
            </span>
          </DropdownMenu.Item>)}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
