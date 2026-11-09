import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { AttachmentPreview } from './attachments';
import type { CitationContext } from './markdown-citations';
import { formatDayLabel } from '../lib/format';
import type { Message } from '../lib/types';
import { RelativeTime } from './relative-time';
import { MessageBlock, type RowDisclosure } from './workstream-blocks';

/**
 * The ordered feed both conversation surfaces render.
 *
 * `conversation-surfaces.md` has named this file since the family was written;
 * until now the list itself lived inline in `workstream.tsx` and the automation
 * draft screen mapped its turns through `MessageBlock` by hand. That second
 * copy is what made a work stream's feed and a draft's diverge on everything
 * the loop around the block does rather than the block itself: virtualization,
 * the unread divider, the oversized-message placeholder, and the three row
 * props the draft screen never passed.
 *
 * What stays out of here is what `conversation-surfaces.md` says stays out —
 * product semantics. This renders turns. Composers, acceptance, templates,
 * run controls, and the empty states that introduce a surface belong to the
 * adapter, which is why this component draws nothing when it has no messages.
 */
interface MessageFeedProps {
  /**
   * How this feed resolves and opens a citation. Absent on a surface with no
   * work stream behind it — an automation draft — where every citation
   * degrades to the label text it already carried.
   */
  citations?: CitationContext;
  currentUserId?: string;
  /** Names the reader on their own elicitation answer; see `MessageBlock`. */
  currentUserName?: string;
  /**
   * Index of the first message under the unread divider, or -1 for none. A
   * surface without unread state passes nothing.
   */
  firstUnreadIndex?: number;
  loadAttachmentContent?: (id: string, signal?: AbortSignal) => Promise<Blob>;
  messages: readonly Message[];
  /** Only event/command arrivals, never a restored snapshot or fetched range. */
  liveMessageIds?: ReadonlySet<string>;
  onAnswerElicitation: (elicitationId: string, answer: string | string[] | null, customResponse?: string) => Promise<void>;
  onOpenAttachment?: (preview: AttachmentPreview) => void;
  /**
   * What the host draws under the last row of a turn. Keyed by transcript
   * turn id.
   */
  afterTurn?: ReadonlyMap<string, React.ReactNode>;
  /** Creates the automation a proposal card names; see its card. */
  onAcceptDraft?: (automationId: string) => void;
  acceptingDraftFor?: string | null;
  acceptDraftFailureFor?: string | null;
  /** Opts this conversation feed into interactive connector tool cards. */
  connectorConnectionCards?: boolean;
  /**
   * Windowing, for the surface that pages.
   *
   * From {@link useMessageFeedVirtualizer}, which the *adapter* calls rather
   * than this component: a work stream drives the same instance to restore an
   * anchor position and to read which rows are on screen for its unread
   * bookkeeping, so the feed cannot be the only thing holding it.
   *
   * Omitted, every message renders. That is the automation draft, whose whole
   * conversation is in memory, has no paging, no "load earlier messages", and
   * ends when the compiler loop does — windowing a list like that buys nothing
   * and costs something real: `getVirtualItems()` measures the scroll element
   * with `getBoundingClientRect`, jsdom lays nothing out and returns zeros, and
   * a virtualized feed under test renders no rows at all. The rows themselves,
   * and every decision about how one looks, are the same either way.
   */
  virtualizer?: Virtualizer<HTMLElement, Element>;
}

/**
 * One estimate, one overscan, one key function, for every surface. Held here
 * because a feed that measures rows differently from the feed beside it is the
 * kind of divergence this file exists to end.
 */
export function useMessageFeedVirtualizer(input: {
  messages: readonly Message[];
  scrollRef: RefObject<HTMLElement | null>;
}): Virtualizer<HTMLElement, Element> {
  return useVirtualizer({
    count: input.messages.length,
    estimateSize: () => 140,
    getItemKey: (index) => input.messages[index]?.id ?? index,
    getScrollElement: () => input.scrollRef.current,
    // A message can reflow by thousands of pixels when the sidebar changes
    // form. TanStack's default callback trusts the ResizeObserver entry that
    // queued the callback; when two width states cross before those callbacks
    // run, an older entry can overwrite the newer row height and the feed
    // alternates between both layouts. Read the row that exists *now* so the
    // virtual ledger and the browser cannot chase one another vertically.
    measureElement: measureMessageFeedRow,
    overscan: 8,
    // The observer fires before the frame containing nested async content is
    // necessarily final. Defer the live read to that frame so Mermaid's SVG
    // replacement and the row measurement settle in one layout pass.
    useAnimationFrameWithResizeObserver: true,
  });
}

/**
 * What a row is to the feed's vertical rhythm.
 *
 * Mirrors the row `MessageBlock` draws for the message: a `turn` is a
 * `.message-block` from a person (a text turn, an answered elicitation), an
 * `answer` is Rally's own `.message-block`, and everything else is an event
 * (machinery rows, a system note, the proposal card, an open elicitation, the
 * oversized-message placeholder). The distinction between a turn and an
 * answer exists for one gap: an answer sits on the work that produced it.
 */
export type FeedRowKind = 'turn' | 'answer' | 'event';

export function feedRowKind(message: Message): FeedRowKind {
  if (message.blocksOmittedPlaceholder) return 'event';
  switch (message.messageType) {
    case 'thought':
    case 'tool_event':
    case 'plugin_activity':
    case 'work_accordion':
      return 'event';
    case 'elicitation':
      if (message.elicitation) return message.elicitation.status === 'answered' ? 'turn' : 'event';
      break;
    default:
      break;
  }
  if (message.draftProposed) return 'event';
  const automation = message.messageType === 'automation_activation';
  if (!automation && (message.authorType === 'system' || message.messageType === 'system')) return 'event';
  return message.authorType === 'human' || message.authorType === 'external' ? 'turn' : 'answer';
}

/**
 * The space a row owns above itself, named for the token that sets it.
 *
 * Decided here from the message list rather than in CSS from a sibling,
 * because the feed is windowed: only the rows inside the virtualizer's window
 * are in the DOM, so the first mounted row has no previous sibling whatever
 * its index. A `+` combinator gave that row no gap while it sat at the
 * window's edge and a different measured height on either side of it, which
 * the ledger then chased. A row after a stretch this client has not loaded
 * has no known predecessor, and takes the seam gap whatever its kind: nothing
 * else marks the seam, and the turn gap it used to take as the honest default
 * is now the closest distance in the feed, which would draw two rows with an
 * unseen stretch between them as the tightest pair on screen.
 */
export type FeedRowGap = 'none' | 'stack' | 'block' | 'event' | 'seam';

export function feedRowGap(previous: Message | undefined, current: Message): FeedRowGap {
  if (!previous) return 'none';
  if (current.precededByTranscriptGap) return 'seam';
  const before = feedRowKind(previous);
  const kind = feedRowKind(current);
  if (before === 'event') return kind === 'turn' ? 'block' : 'event';
  return kind === 'event' ? 'block' : 'stack';
}

/** The live border-box height used by the work-stream feed's virtual ledger. */
export function measureMessageFeedRow(element: Element): number {
  return Math.round(element.getBoundingClientRect().height);
}

export function MessageFeed({
  afterTurn,
  citations,
  currentUserId,
  currentUserName,
  firstUnreadIndex = -1,
  loadAttachmentContent,
  messages,
  liveMessageIds,
  onAnswerElicitation,
  onOpenAttachment,
  onAcceptDraft,
  acceptingDraftFor,
  acceptDraftFailureFor,
  connectorConnectionCards = false,
  virtualizer,
}: MessageFeedProps): React.JSX.Element {
  const feed = useRef<HTMLDivElement>(null);
  // Keep consumed globally unique row IDs for this feed's lifetime, including
  // route revisits: a still-live cached overlay must not replay on navigation.
  const seen = useRef(new Set<string>());
  useLayoutEffect(() => {
    const entering = new Set<string>();
    const liveIds = [...(liveMessageIds ?? [])];
    for (const message of messages) {
      // Only text replacements reconcile at turn scope. Tools and plugin groups
      // are independent rows, even when they share the text's turn/client ID.
      const identity = message.messageType === 'text'
        ? `text:${message.clientMessageId ?? message.transcriptTurnId ?? message.id}`
        : `row:${message.id}`;
      const live = liveMessageIds?.has(message.id) || (message.messageType === 'plugin_activity'
        && liveIds.some((id) => message.id.startsWith(`${id}:plugin-group:`)));
      if (!seen.current.has(identity) && live) entering.add(message.id);
      // Consume offscreen arrivals too: scrolling them into view is not arrival.
      seen.current.add(identity);
    }
    if (!entering.size || document.visibilityState === 'hidden' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    for (const element of feed.current?.querySelectorAll<HTMLElement>('[data-arrival-id]') ?? []) {
      if (!entering.has(element.dataset.arrivalId ?? '') || !element.animate) continue;
      element.animate([
        { opacity: 0, transform: element.dataset.arrivalKind === 'plugin_activity' ? 'scale(.92)' : 'translateY(12px) scale(.94)' },
        { opacity: 1, transform: 'translateY(0) scale(1)' },
      ], { duration: 240, easing: 'cubic-bezier(.23, 1, .32, 1)' });
    }
  }, [messages, liveMessageIds]);
  // Held here rather than by each adapter: which rows a reader has opened is
  // feed state, it resets when the feed unmounts, and neither screen did
  // anything else with it. One set for both kinds of collapsible row — a
  // clamped system note and a settled run's work accordion — because message
  // ids are unique and the question is the same one.
  const [expandedRows, setExpandedRows] = useState<ReadonlySet<string>>(new Set());
  // A virtualized row unmounts when it leaves the window. The first successful
  // connection observation belongs to the feed, so remounting the historical
  // card cannot turn it back into a recovery action during this feed session.
  const [connectedConnectorSelections, setConnectedConnectorSelections] = useState<ReadonlySet<string>>(new Set());
  const markConnectorConnected = useCallback((selectionKey: string) => {
    setConnectedConnectorSelections((current) => {
      if (current.has(selectionKey)) return current;
      const next = new Set(current);
      next.add(selectionKey);
      return next;
    });
  }, []);
  const [latchedAuthorizedResourceToolIds, setLatchedAuthorizedResourceToolIds] = useState<ReadonlySet<string>>(new Set());
  const markResourceAuthorized = useCallback((failedToolInvocationId: string) => {
    setLatchedAuthorizedResourceToolIds((current) => {
      if (current.has(failedToolInvocationId)) return current;
      const next = new Set(current);
      next.add(failedToolInvocationId);
      return next;
    });
  }, []);
  const authorizedResourceToolIds = useMemo(() => {
    const ids = new Set(latchedAuthorizedResourceToolIds);
    for (const message of messages) {
      if (message.authorType !== 'human') continue;
      const id = message.clientMessageId?.match(/^resource-authorization:(.+)$/u)?.[1];
      if (id) ids.add(id);
    }
    return ids;
  }, [latchedAuthorizedResourceToolIds, messages]);
  const rowDisclosure = useMemo<RowDisclosure>(() => ({
    expanded: expandedRows,
    onToggle: (messageId) => setExpandedRows((current) => {
      const next = new Set(current);
      if (!next.delete(messageId)) next.add(messageId);
      return next;
    }),
  }), [expandedRows]);
  // A turn can be several rows — its text and the tools around it — and its
  // cards belong after the last of them, where the turn ends.
  const lastRowOfTurn = useMemo(() => {
    const last = new Map<string, number>();
    if (!afterTurn || afterTurn.size === 0) return last;
    messages.forEach((message, index) => {
      if (message.transcriptTurnId && afterTurn.has(message.transcriptTurnId)) {
        last.set(message.transcriptTurnId, index);
      }
    });
    return last;
  }, [afterTurn, messages]);
  const cardsAfter = (message: Message, index: number): React.JSX.Element | null => {
    const turnId = message.transcriptTurnId;
    if (!turnId || lastRowOfTurn.get(turnId) !== index) return null;
    const hostContent = afterTurn?.get(turnId) ?? null;
    return hostContent ? <div className="turn-host-content">{hostContent}</div> : null;
  };
  const row = (message: Message, index: number): React.JSX.Element => (
    <div className="message-arrival-layer" data-arrival-id={message.id} data-arrival-kind={message.messageType}>
      {startsDay(messages[index - 1], message) && (
        <div className="day-divider" role="separator"><RelativeTime format={formatDayLabel} value={message.createdAt} /></div>
      )}
      {index === firstUnreadIndex && (
        <div className="unread-divider" role="separator"><span>Unread messages</span></div>
      )}
      {message.blocksOmittedPlaceholder ? (
        <div className="transcript-history-control" role="status">
          <span>This message is too large to display.</span>
        </div>
      ) : (
        <MessageBlock
          {...(citations ? { citations } : {})}
          collapseHeadings
          currentUserId={currentUserId}
          currentUserName={currentUserName}
          loadAttachmentContent={loadAttachmentContent}
          message={message}
          onAnswerElicitation={onAnswerElicitation}
          onOpenAttachment={onOpenAttachment}
          rowDisclosure={rowDisclosure}
          {...(onAcceptDraft ? { onAcceptDraft } : {})}
          acceptingDraftFor={acceptingDraftFor ?? null}
          acceptDraftFailureFor={acceptDraftFailureFor ?? null}
          connectorConnectionCards={connectorConnectionCards}
          connectedConnectorSelections={connectedConnectorSelections}
          onConnectorConnected={markConnectorConnected}
          authorizedResourceToolIds={authorizedResourceToolIds}
          onResourceAuthorized={markResourceAuthorized}
        />
      )}
      {cardsAfter(message, index)}
    </div>
  );

  if (!virtualizer) {
    return (
      <div className="virtual-transcript" ref={feed}>
        {messages.map((message, index) => (
          <div className="virtual-message-row" data-index={index} data-row-gap={feedRowGap(messages[index - 1], message)} key={message.id}>
            {row(message, index)}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      className="virtual-transcript"
      ref={feed}
      style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}
    >
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const message = messages[virtualRow.index];
        if (!message) return null;
        return (
          <div
            className="virtual-message-row"
            data-index={virtualRow.index}
            data-row-gap={feedRowGap(messages[virtualRow.index - 1], message)}
            key={message.id}
            ref={virtualizer.measureElement}
            style={{
              left: 0,
              position: 'absolute',
              top: 0,
              transform: `translateY(${virtualRow.start}px)`,
              width: '100%',
            }}
          >
            {row(message, virtualRow.index)}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Whether a row is the first of its local day, so the feed names the day above
 * it ("Today", "Yesterday", a weekday, a date) and each byline carries only the
 * clock time, as design.html §2 draws the transcript.
 */
function startsDay(previous: Message | undefined, message: Message): boolean {
  if (!previous) return true;
  const a = new Date(previous.createdAt);
  const b = new Date(message.createdAt);
  return a.getFullYear() !== b.getFullYear() || a.getMonth() !== b.getMonth() || a.getDate() !== b.getDate();
}
