import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';
import { useMemo, useState, type RefObject } from 'react';
import type { AttachmentPreview } from './attachments';
import type { CitationContext } from './markdown-citations';
import type { Message } from '../lib/types';
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
  /** The main work-stream feed presents an agent's h2 document as a card deck. */
  agentDocumentCards?: boolean;
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
  onAnswerElicitation: (elicitationId: string, answer: string | string[] | null, customResponse?: string) => Promise<void>;
  onOpenAttachment?: (preview: AttachmentPreview) => void;
  onStartSubstream?: (throughTurnId: string) => void;
  /** Creates the automation a proposal card names; see its card. */
  onAcceptDraft?: (automationId: string) => void;
  acceptingDraftFor?: string | null;
  acceptDraftError?: string | undefined;
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

/** The live border-box height used by the work-stream feed's virtual ledger. */
export function measureMessageFeedRow(element: Element): number {
  return Math.round(element.getBoundingClientRect().height);
}

export function MessageFeed({
  agentDocumentCards = false,
  citations,
  currentUserId,
  currentUserName,
  firstUnreadIndex = -1,
  loadAttachmentContent,
  messages,
  onAnswerElicitation,
  onOpenAttachment,
  onStartSubstream,
  onAcceptDraft,
  acceptingDraftFor,
  acceptDraftError,
  virtualizer,
}: MessageFeedProps): React.JSX.Element {
  // Held here rather than by each adapter: which rows a reader has opened is
  // feed state, it resets when the feed unmounts, and neither screen did
  // anything else with it. One set for both kinds of collapsible row — a
  // clamped system note and a settled run's work accordion — because message
  // ids are unique and the question is the same one.
  const [expandedRows, setExpandedRows] = useState<ReadonlySet<string>>(new Set());
  const rowDisclosure = useMemo<RowDisclosure>(() => ({
    expanded: expandedRows,
    onToggle: (messageId) => setExpandedRows((current) => {
      const next = new Set(current);
      if (!next.delete(messageId)) next.add(messageId);
      return next;
    }),
  }), [expandedRows]);
  const row = (message: Message, index: number): React.JSX.Element => (
    <>
      {index === firstUnreadIndex && (
        <div className="unread-divider" role="separator"><span>Unread messages</span></div>
      )}
      {message.blocksOmittedPlaceholder ? (
        <div className="transcript-history-control" role="status">
          <span>This message is too large to display.</span>
        </div>
      ) : (
        <MessageBlock
          agentDocumentCards={agentDocumentCards}
          {...(citations ? { citations } : {})}
          collapseHeadings
          currentUserId={currentUserId}
          currentUserName={currentUserName}
          loadAttachmentContent={loadAttachmentContent}
          message={message}
          onAnswerElicitation={onAnswerElicitation}
          onOpenAttachment={onOpenAttachment}
          onStartSubstream={onStartSubstream}
          rowDisclosure={rowDisclosure}
          {...(onAcceptDraft ? { onAcceptDraft } : {})}
          acceptingDraftFor={acceptingDraftFor ?? null}
          acceptDraftError={acceptDraftError}
        />
      )}
    </>
  );

  if (!virtualizer) {
    return (
      <div className="virtual-transcript">
        {messages.map((message, index) => (
          <div className="virtual-message-row" data-index={index} key={message.id}>
            {row(message, index)}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      className="virtual-transcript"
      style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}
    >
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const message = messages[virtualRow.index];
        if (!message) return null;
        return (
          <div
            className="virtual-message-row"
            data-index={virtualRow.index}
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
