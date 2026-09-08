import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ConversationVisibilityContext } from '../lib/conversation-visibility';
import { ChevronLeft } from 'lucide-react';
import { Link } from 'react-router-dom';

/** The profile and conversation scroll independently; switching views keeps the chat mounted. */
export function SidekickDetailLayout({ overview, children }: { overview: ReactNode; children: ReactNode }): React.JSX.Element {
  const [view, setView] = useState<'conversation' | 'details'>('conversation');
  const container = useRef<HTMLElement>(null);
  const [compact, setCompact] = useState(false);
  // 340px profile + 560px conversation: measure the host, including inside AppShell.
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = (): void => setCompact(element.getBoundingClientRect().width < 900);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const conversationVisible = !compact || view === 'conversation';
  return <main ref={container} data-compact={compact} className="sidekick-detail" data-view={view}>
    <nav aria-label="Sidekick navigation" className="sidekick-navigation window-drag">
      <Link className="sidekick-back window-no-drag" to="/sidekicks"><ChevronLeft aria-hidden="true" size={18} />Sidekicks</Link>
      <div className="sidekick-view-switch window-no-drag" role="group" aria-label="Sidekick view">
        <button type="button" aria-pressed={view === 'conversation'} onClick={() => setView('conversation')}>Conversation</button>
        <button type="button" aria-pressed={view === 'details'} onClick={() => setView('details')}>Details</button>
      </div>
    </nav>
    <div className="sidekick-detail-body">
      <aside inert={compact && view !== 'details'} aria-hidden={compact && view !== 'details'} aria-label="Sidekick details" className="sidekick-profile">{overview}</aside>
      <section inert={!conversationVisible} aria-hidden={!conversationVisible} aria-label="Sidekick conversation" className="sidekick-conversation"><ConversationVisibilityContext value={conversationVisible}>{children}</ConversationVisibilityContext></section>
    </div>
  </main>;
}
