import clsx from 'clsx';
import type { AutomationSummary } from '../lib/types';
import { desktopBridge } from '../lib/platform';
import { WorkstreamGlyph } from './workstream-glyph';

/**
 * Where a Thread-owned Sidekick lives: the Thread's glyph and name, as a
 * button that opens it in the main window. The server names the Thread only to
 * a reader who is in it, so without one this is the plain word "Thread".
 *
 * A button rather than a link because the Thread opens in another window in
 * the Mac app; `openThread` is that hand-off, and a route in the browser tab.
 */
export function OwningThreadLabel({ thread, className }: {
  thread: AutomationSummary['owningThread'];
  className?: string;
}): React.JSX.Element {
  if (!thread) return <span className={className}>Thread</span>;
  return (
    <button
      className={clsx('owning-thread-link', className)}
      onClick={() => { void desktopBridge().openThread(thread.id); }}
      title="Open thread"
      type="button"
    >
      <WorkstreamGlyph {...(thread.appearance ? { appearance: thread.appearance } : {})} id={thread.id} size={16} />
      <span className="owning-thread-link-title">{thread.title}</span>
    </button>
  );
}
