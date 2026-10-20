import * as Tooltip from '@radix-ui/react-tooltip';
import type { WorkstreamAppearance } from '@rally/contracts';
import { IconCornerDownRight } from '@tabler/icons-react';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { statusLabel } from '../lib/format';

/**
 * What a Channel's feed knows about one of its Breakouts: enough to place it
 * under the message it started from and to say whether it has news.
 */
export interface BreakoutMark {
  resolved?: boolean | undefined;
  substreamId: string;
  title: string;
  appearance?: WorkstreamAppearance | undefined;
  /** The Main turn the Breakout branched through; null or absent when unknown. */
  originTurnId?: string | null | undefined;
  lastActivityAt?: string | undefined;
  createdAt?: string | undefined;
  unreadCount?: number | undefined;
  youAreMentioned?: boolean | undefined;
  unseen?: boolean | undefined;
  /** A host that has no counts, only the directory's one flag. */
  needsAttention?: boolean | undefined;
  /** The Breakout's run is paused on a question only it can answer. */
  needsInput?: boolean | undefined;
  /** Who started it; absent when the host does not know yet. */
  createdByUserId?: string | undefined;
  /** Rally is still choosing its title: a skeleton stands in, as in its title pill. */
  naming?: boolean | undefined;
}

/** Whether a Breakout has something its reader has not seen. */
export function breakoutHasActivity(breakout: BreakoutMark): boolean {
  return breakout.needsInput === true || (breakout.unreadCount ?? 0) > 0 || breakout.youAreMentioned === true
    || breakout.unseen === true || breakout.needsAttention === true;
}

/**
 * "Needs input" while a question waits, else "2 new", or "New" when the host
 * knows there is news but not how much.
 */
export function breakoutNewsLabel(breakout: BreakoutMark): string | null {
  if (breakout.needsInput === true) return statusLabel.needs_input;
  const count = breakout.unreadCount ?? 0;
  if (count > 0) return `${count} new`;
  return breakoutHasActivity(breakout) ? 'New' : null;
}

/** The Breakouts started from each Main turn, in the order they were made. */
export function breakoutsByOrigin(breakouts: readonly BreakoutMark[]): Map<string, BreakoutMark[]> {
  const result = new Map<string, BreakoutMark[]>();
  for (const breakout of [...breakouts].sort(compareCreated)) {
    if (!breakout.originTurnId) continue;
    result.set(breakout.originTurnId, [...result.get(breakout.originTurnId) ?? [], breakout]);
  }
  return result;
}

/**
 * The tick bar's order: by the position of the origin turn in the loaded
 * transcript where it is loaded, and by creation time for the rest, which sit
 * after every placed tick because their messages are further back than the
 * page in hand.
 */
export function orderBreakoutsForTicks(breakouts: readonly BreakoutMark[], turnOrder: readonly string[]): BreakoutMark[] {
  const position = new Map(turnOrder.map((turnId, index) => [turnId, index]));
  const placed = (breakout: BreakoutMark): number | undefined => (
    breakout.originTurnId ? position.get(breakout.originTurnId) : undefined
  );
  return [...breakouts].sort((a, b) => {
    const left = placed(a);
    const right = placed(b);
    if (left !== undefined && right !== undefined && left !== right) return left - right;
    if (left !== undefined && right === undefined) return -1;
    if (left === undefined && right !== undefined) return 1;
    return compareCreated(a, b);
  });
}

function compareCreated(a: BreakoutMark, b: BreakoutMark): number {
  return (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.substreamId.localeCompare(b.substreamId);
}

/**
 * One tick per Breakout down the Channel's leading edge. A quiet Breakout is a
 * short grey tick, one with news a longer red one, and the open one the
 * longest. Hovering a tick names it; pressing one opens it.
 */
export function BreakoutTickBar({ breakouts, onOpen, openSubstreamId, renderAge }: {
  breakouts: readonly BreakoutMark[];
  onOpen: (breakout: BreakoutMark) => void;
  openSubstreamId: string | null;
  renderAge?: (breakout: BreakoutMark) => ReactNode;
}): React.JSX.Element | null {
  if (breakouts.length === 0) return null;
  return <nav aria-label="Breakouts in this thread" className="breakout-tick-bar">
    {breakouts.map((breakout) => {
      const open = breakout.substreamId === openSubstreamId;
      const news = breakoutNewsLabel(breakout);
      const age = renderAge?.(breakout);
      return <Tooltip.Root delayDuration={120} key={breakout.substreamId}>
        <Tooltip.Trigger asChild>
          <button
            aria-current={open ? 'true' : undefined}
            aria-label={[breakout.title, news].filter(Boolean).join(', ')}
            className={clsx('breakout-tick', news && 'has-news', open && 'is-open')}
            onClick={() => onOpen(breakout)}
            type="button"
          >
            <span aria-hidden="true" className="breakout-tick-mark" />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content align="center" className="breakout-tick-card" collisionPadding={12} side="right" sideOffset={10}>
            <span className="breakout-tick-card-title">
              <IconCornerDownRight aria-hidden="true" size={14} stroke={1.9} />
              <span>{breakout.title}</span>
            </span>
            {(news || age) && <span className="breakout-tick-card-meta">
              {news && <span className="breakout-tick-card-news">{news}</span>}
              {news && age ? <span aria-hidden="true">·</span> : null}
              {age}
            </span>}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>;
    })}
  </nav>;
}
