import type { CookieClientSession } from '@rally/contracts/client-session';
import type { Region } from '@rally/contracts/regions';
import BrowserConversation from './conversation';
import { BrowserMemberShell } from './member-shell';

/**
 * The signed-in application's one lazy boundary. Guests get the guest
 * collaboration shell; members get the desktop shell.
 */
export default function BrowserWorkspace({ shell, region, session, onSignOut, onRevalidate }: {
  shell: 'guest' | 'member';
  region: Region;
  session: CookieClientSession;
  onSignOut: () => void;
  onRevalidate: () => void;
}): React.JSX.Element {
  return shell === 'member'
    ? <BrowserMemberShell onRevalidate={onRevalidate} onSignOut={onSignOut} region={region} session={session} />
    : <BrowserConversation onSignOut={onSignOut} session={session} />;
}
