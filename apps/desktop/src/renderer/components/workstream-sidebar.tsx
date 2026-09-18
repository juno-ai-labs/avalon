import { WorkstreamSidebar as SharedWorkstreamSidebar } from '@rally/ui/components/workstream-sidebar';
import { desktopBridge } from '../lib/platform';
export type { ConversationRowTarget, ConversationRowActions } from '@rally/ui/components/workstream-sidebar';
export function WorkstreamSidebar(props: React.ComponentProps<typeof SharedWorkstreamSidebar>): React.JSX.Element {
  return <SharedWorkstreamSidebar {...props} onOpenSidekick={(id) => { void desktopBridge().openSidekicks(id); }} />;
}
