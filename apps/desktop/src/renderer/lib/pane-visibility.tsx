import { useContext, type PropsWithChildren } from 'react';
import { ConversationVisibilityContext } from './conversation-visibility';

/**
 * A pane a split layout keeps mounted but is not drawing: a Channel behind its
 * thread on a narrow window or beside a breakout, or a thread behind its
 * breakout. Inside it nothing reads as seen, so a hidden pane acknowledges no
 * read; an outer host that hides the whole conversation still wins.
 */
export function PaneVisibility({ children, visible }: PropsWithChildren<{ visible: boolean }>): React.JSX.Element {
  const outer = useContext(ConversationVisibilityContext);
  return <ConversationVisibilityContext value={outer && visible}>{children}</ConversationVisibilityContext>;
}
