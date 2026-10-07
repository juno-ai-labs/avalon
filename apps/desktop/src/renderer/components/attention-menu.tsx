import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { ConversationAccessRequestItem } from '@rally/contracts';
import { IconBell, IconCancel, IconCheck } from '@tabler/icons-react';
import { forwardRef, useState, type ButtonHTMLAttributes } from 'react';
import { useNavigate } from 'react-router-dom';

import { attentionItemPath, type AttentionItem } from '../lib/attention-items';
import { formatSidebarActivityTime, statusLabel } from '../lib/format';
import { StatusDot, Tip } from './primitives';
import { RelativeTime } from './relative-time';
import { WorkstreamGlyph } from './workstream-glyph';

const NOTHING_NEEDS_ATTENTION = 'Nothing needs your attention';
const STILL_LOADING = 'Still loading channels';

function attentionLabel(count: number, requests: number): string {
  const conversations = count - requests;
  if (conversations === 0) return requests === 1 ? '1 access request' : `${requests} access requests`;
  const waiting = conversations === 1 ? '1 conversation needs your attention' : `${conversations} conversations need your attention`;
  return requests === 0 ? waiting : `${waiting}, and ${requests === 1 ? '1 access request' : `${requests} access requests`}`;
}

export type AccessDecision = 'approve' | 'decline';

/** What a request row says: who asked, for what. */
export function accessRequestSummary(request: ConversationAccessRequestItem): string {
  return `${request.requesterName} asked to join ${request.title}`;
}

/**
 * The trigger: a red count while anything is waiting, a bell when nothing is.
 * A plain button so Radix's trigger and the tooltip can both pass it a ref.
 */
const AttentionTrigger = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { count: number; label: string }>(
  function AttentionTrigger({ count, label, ...props }, ref) {
    return <button
      ref={ref}
      aria-label={label}
      className={count > 0 ? 'icon-button attention-trigger has-attention' : 'icon-button attention-trigger'}
      type="button"
      {...props}
    >
      {/* The button stays 32px, the width the sidebar's minimum is sized for:
          past two digits the count is shown as 99+ and the label keeps the number. */}
      {count > 0
        ? <span aria-hidden="true" className={count > 99 ? 'attention-count is-capped' : 'attention-count'}>{count > 99 ? '99+' : count}</span>
        : <IconBell aria-hidden="true" size={16} stroke={1.9} />}
    </button>;
  },
);

/**
 * The sidebar's attention menu: every Channel and Breakout waiting for this
 * reader, each a link to where it is waiting. `docs/attention-menu.md`.
 */
export function AttentionMenu({ items, complete = true, requests = [], onDecide, onOpenRequest, decisionFailed = false }: {
  items: readonly AttentionItem[];
  /** Access requests waiting on this person, listed first with their two buttons. */
  requests?: readonly ConversationAccessRequestItem[];
  onDecide?: (request: ConversationAccessRequestItem, decision: AccessDecision) => void;
  /** Choosing the row rather than a button: open the request's dialog. */
  onOpenRequest?: (request: ConversationAccessRequestItem) => void;
  /** The last approve or decline was refused; its row is back in the list. */
  decisionFailed?: boolean;
  /**
   * False while the Channel directory is still loading or partly unloaded, so
   * an empty list is not yet "nothing". The items are what has loaded.
   */
  complete?: boolean;
}): React.JSX.Element {
  const navigate = useNavigate();
  const count = items.length + requests.length;
  const label = count > 0 ? attentionLabel(count, requests.length) : complete ? NOTHING_NEEDS_ATTENTION : STILL_LOADING;
  const [open, setOpen] = useState(false);
  // The tip would sit over the menu's first row; it is closed while the menu is open.
  const [tipOpen, setTipOpen] = useState(false);
  return <DropdownMenu.Root onOpenChange={(next) => { setOpen(next); if (next) setTipOpen(false); }} open={open}>
    <Tip
      describesTrigger={false}
      label={label}
      onOpenChange={(next) => setTipOpen(next && !open)}
      open={tipOpen}
      side="bottom"
    >
      <DropdownMenu.Trigger asChild>
        <AttentionTrigger count={count} label={label} />
      </DropdownMenu.Trigger>
    </Tip>
    <DropdownMenu.Portal>
      <DropdownMenu.Content align="start" aria-label="Needs your attention" className="menu-content attention-menu" collisionPadding={8} sideOffset={6}>
        {decisionFailed && <div className="attention-menu-error" role="alert">That didn’t go through. Try again.</div>}
        {requests.map((request) => <div
          aria-label={accessRequestSummary(request)}
          className="attention-menu-request"
          key={`request:${request.id}`}
          role="group"
        >
          {/* The row itself opens the request's dialog, with its full
              wording and the two choices as labelled buttons. */}
          <DropdownMenu.Item
            className="attention-menu-request-open"
            onSelect={() => onOpenRequest?.(request)}
          >
            <WorkstreamGlyph appearance={request.appearance ?? undefined} id={request.markId} size={20} />
            <span className="attention-menu-text">
              <span className="attention-menu-title">{request.title}</span>
              <span className="attention-menu-detail">{request.requesterName} asked to join</span>
            </span>
          </DropdownMenu.Item>
          {/* Items, so arrow keys reach them like any other row; selecting
              one keeps the menu open for the next request. */}
          <Tip describesTrigger={false} label="Approve" side="top">
            <DropdownMenu.Item
              aria-label={`Approve ${request.requesterName}`}
              className="decision-button is-approve"
              onSelect={(event) => { event.preventDefault(); onDecide?.(request, 'approve'); }}
            >
              <IconCheck aria-hidden="true" size={16} stroke={2} />
            </DropdownMenu.Item>
          </Tip>
          <Tip describesTrigger={false} label="Decline" side="top">
            <DropdownMenu.Item
              aria-label={`Decline ${request.requesterName}`}
              className="decision-button is-decline"
              onSelect={(event) => { event.preventDefault(); onDecide?.(request, 'decline'); }}
            >
              <IconCancel aria-hidden="true" size={16} stroke={2} />
            </DropdownMenu.Item>
          </Tip>
        </div>)}
        {count === 0
          ? <div className="attention-menu-empty">{complete ? NOTHING_NEEDS_ATTENTION : STILL_LOADING}</div>
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
        {count > 0 && !complete && <div className="attention-menu-empty">{STILL_LOADING}</div>}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}

