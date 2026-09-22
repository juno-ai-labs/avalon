import { WorkstreamSidebar as SharedWorkstreamSidebar } from '@rally/ui/components/workstream-sidebar';
import { desktopBridge } from '../lib/platform';
import { useRef } from 'react';
import { useSemanticScroll } from '../lib/desktop-layout';
export type { ConversationRowTarget, ConversationRowActions } from '@rally/ui/components/workstream-sidebar';
export function WorkstreamSidebar({ scrollStateKey, ...props }: React.ComponentProps<typeof SharedWorkstreamSidebar> & { scrollStateKey?: string }): React.JSX.Element {
  const scrollRef = useRef<HTMLElement | null>(null);
  useSemanticScroll(scrollRef, scrollStateKey ?? 'rally.desktop-layout:channel-context',
    '[data-layout-id]', props.workstream.privateChildren !== undefined);
  return <SharedWorkstreamSidebar {...props} scrollRef={scrollRef} onOpenSidekick={(id) => { void desktopBridge().openSidekicks(id); }} />;
}
