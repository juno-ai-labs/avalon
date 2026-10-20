import { IconChevronRight } from '@tabler/icons-react';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { breakoutNewsLabel, type BreakoutMark } from './breakout-marks';
import { TitleSkeleton } from './primitives';
import { resolveWorkstreamAppearance } from './workstream-glyph';

/**
 * One conversation as an entry in a feed: its title and news, an optional
 * summary, a byline the host draws, and the conversation's own mark beside
 * them. The whole entry is the button that opens it. A Channel's feed draws
 * its threads with it, and a thread's feed draws its Breakouts with it. Both
 * sit on the trailing side: a person started them.
 */
export function ConversationCard({ conversation, meta, onOpen, open, private: isPrivate = false, summary }: {
  conversation: BreakoutMark;
  /** Who started it and when, as the host can name them. */
  meta?: ReactNode;
  onOpen: () => void;
  open: boolean;
  /** The thread's own privacy, supplied by its host independently of resolution. */
  private?: boolean;
  summary?: ReactNode;
}): React.JSX.Element {
  // No "new" on the conversation the reader has open beside it, which they
  // are reading as it arrives; a question waiting on them still shows.
  const news = breakoutNewsLabel(open
    ? { ...conversation, unreadCount: 0, youAreMentioned: false, unseen: false, needsAttention: false }
    : conversation);
  const { Icon, tint, ink } = resolveWorkstreamAppearance(conversation.substreamId, conversation.appearance);
  return <button
    aria-label={[conversation.naming ? 'Rally is choosing a name' : conversation.title, conversation.resolved && 'Resolved', isPrivate && 'Private', news, open && 'Open'].filter(Boolean).join(', ')}
    aria-pressed={open}
    className={clsx('conversation-card', conversation.resolved && 'is-resolved', open && 'is-open')}
    onClick={onOpen}
    type="button"
  >
    <span className="conversation-card-body">
      <span className="conversation-card-title">
        {news && (conversation.needsInput
          ? <span className="conversation-card-badge">{news}</span>
          : <span className="conversation-card-news">{news}</span>)}
        <span className="conversation-card-title-text">{conversation.naming ? <TitleSkeleton /> : conversation.title}</span>
        <IconChevronRight aria-hidden="true" className="conversation-card-caret" size={13} stroke={2} />
      </span>
      {summary && <span className="conversation-card-summary">{summary}</span>}
      {(meta || conversation.resolved || isPrivate) && <span className="conversation-card-meta">
        {meta}
        {conversation.resolved && <span className="conversation-card-pill">Resolved</span>}
        {isPrivate && <span className="conversation-card-pill">Private</span>}
      </span>}
    </span>
    <span aria-hidden="true" className="conversation-card-mark" style={{ background: tint, color: ink }}>
      <Icon size={19} strokeWidth={1.8} />
    </span>
  </button>;
}
