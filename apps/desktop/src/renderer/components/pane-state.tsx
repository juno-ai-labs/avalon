import { TitlePillLeading, TitlePillNavigation } from '@rally/ui/components/title-pill';
import type { ReactNode } from 'react';

import { EmptyState } from './primitives';

/**
 * A pane that has nothing to show but a sentence: a link to a Canvas that does
 * not exist, a conversation the connection cannot reach. One in-pane state,
 * never a dialog over it, under a header that keeps the shell's Back and
 * Forward (and the phone's menu button), so the way out is where it always is.
 */
export function PaneState({ action, description, title, trailing }: {
  action?: ReactNode;
  description: string;
  title: string;
  /** Controls at the header's right edge, such as a menu that copies an id for support. */
  trailing?: ReactNode;
}): React.JSX.Element {
  return <div className="pane-state">
    <header className="pane-state-header window-drag">
      <TitlePillLeading />
      <TitlePillNavigation />
      {trailing && <span className="pane-state-trailing window-no-drag">{trailing}</span>}
    </header>
    <div className="pane-state-body">
      <EmptyState action={action} description={description} title={title} />
    </div>
  </div>;
}
