import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ConversationVisibilityContext } from '../lib/conversation-visibility';

/** What the header needs to offer the details at a width where they do not fit beside the conversation. */
export interface SidekickDetailHeaderContext {
  /** The details are not beside the conversation, so the header offers a way to them. */
  compact: boolean;
  detailsOpen: boolean;
  toggleDetails: () => void;
}

/**
 * A Sidekick open, laid out as design §4 draws it and as a Canvas is: one
 * header over the main column (the title pill with Back and Forward, the face
 * pile), the conversation under it, and the details in a column on the right.
 * Where both do not fit, the details take the conversation's place under the
 * same header, and the header's Details button switches between them; the
 * conversation stays mounted either way, so an unsent message survives.
 */
export function SidekickDetailLayout({ header, details, children }: {
  header: (context: SidekickDetailHeaderContext) => ReactNode;
  details: ReactNode;
  children: ReactNode;
}): React.JSX.Element {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const container = useRef<HTMLElement>(null);
  const [compact, setCompact] = useState(false);
  // The details column (340px) beside a conversation of 560px, the narrowest a
  // composer and a run row read at: measured on the host, which inside the
  // shell is narrower than the window.
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = (): void => setCompact(element.getBoundingClientRect().width < 900);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const showingDetails = compact && detailsOpen;
  return <main ref={container} data-compact={compact} className="sidekick-detail" data-view={showingDetails ? 'details' : 'conversation'}>
    <div className="sidekick-detail-header window-drag">{header({ compact, detailsOpen: showingDetails, toggleDetails: () => setDetailsOpen((open) => !open) })}</div>
    <section inert={showingDetails} aria-hidden={showingDetails} aria-label="Sidekick conversation" className="sidekick-conversation"><ConversationVisibilityContext value={!showingDetails}>{children}</ConversationVisibilityContext></section>
    <aside inert={compact && !showingDetails} aria-hidden={compact && !showingDetails} aria-label="Sidekick details" className="sidekick-profile">{details}</aside>
  </main>;
}
