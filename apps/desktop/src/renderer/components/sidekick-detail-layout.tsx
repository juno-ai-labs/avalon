import { useState, type ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';
import { Link } from 'react-router-dom';

/** The profile and conversation scroll independently; switching views keeps the chat mounted. */
export function SidekickDetailLayout({ overview, children }: { overview: ReactNode; children: ReactNode }): React.JSX.Element {
  const [view, setView] = useState<'conversation' | 'details'>('conversation');
  return <main className="sidekick-detail" data-view={view}>
    <nav aria-label="Sidekick navigation" className="sidekick-navigation window-drag">
      <Link className="sidekick-back window-no-drag" to="/sidekicks"><ChevronLeft aria-hidden="true" size={18} />Sidekicks</Link>
      <div className="sidekick-view-switch window-no-drag" role="group" aria-label="Sidekick view">
        <button type="button" aria-pressed={view === 'conversation'} onClick={() => setView('conversation')}>Conversation</button>
        <button type="button" aria-pressed={view === 'details'} onClick={() => setView('details')}>Details</button>
      </div>
    </nav>
    <div className="sidekick-detail-body">
      <aside aria-label="Sidekick details" className="sidekick-profile">{overview}</aside>
      <section aria-label="Sidekick conversation" className="sidekick-conversation">{children}</section>
    </div>
  </main>;
}
