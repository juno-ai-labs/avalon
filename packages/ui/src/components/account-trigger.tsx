import { ChevronDown } from 'lucide-react';
import { Avatar } from './primitives';
import type { WorkspaceMember } from '../lib/types';
import type { ComponentProps } from 'react';
export function AccountTrigger({ currentUser, workspaceName, description, presentation = 'workspace', hasAttention, ...props }:
  ComponentProps<'button'> & { currentUser: WorkspaceMember; workspaceName: string; description?: string | null;
    presentation?: 'workspace' | 'grok'; hasAttention?: boolean }): React.JSX.Element {
  return <button aria-label={[currentUser.name, workspaceName, description].filter(Boolean).join(', ')}
    className="account-trigger window-no-drag" type="button" {...props}>
    <Avatar member={currentUser} size="small" />
    <span className="account-copy"><strong>{currentUser.name}</strong>
      {presentation === 'workspace' && <span>{workspaceName}</span>}</span>
    {presentation === 'workspace' && hasAttention && <span aria-hidden="true" className="account-attention-dot" />}
    {presentation === 'workspace' && <ChevronDown aria-hidden="true" size={14} />}
  </button>;
}
