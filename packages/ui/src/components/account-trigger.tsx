import clsx from 'clsx';
import { ChevronDown } from 'lucide-react';
import { Avatar } from './primitives';
import type { WorkspaceMember } from '../lib/types';
import type { ComponentProps } from 'react';

/**
 * The account footer's button. On a support session (`docs/impersonation.md`)
 * `currentUser` is the person being acted as and `impersonator` the Rally staff
 * member acting; the staff member's avatar sits on the right so nobody mistakes
 * the session for their own.
 */
export function AccountTrigger({ currentUser, workspaceName, description, presentation = 'workspace', hasAttention, impersonator, className, ...props }:
  ComponentProps<'button'> & { currentUser: WorkspaceMember; workspaceName: string; description?: string | null;
    presentation?: 'workspace' | 'grok'; hasAttention?: boolean; impersonator?: WorkspaceMember | null }): React.JSX.Element {
  const impersonation = impersonator ? `impersonated by ${impersonator.name}` : null;
  return <button aria-label={[currentUser.name, workspaceName, impersonation, description].filter(Boolean).join(', ')}
    className={clsx("account-trigger window-no-drag", impersonator && "is-impersonating", className)} type="button" {...props}>
    <Avatar member={currentUser} size="small" />
    <span className="account-copy"><strong>{currentUser.name}</strong>
      {presentation === 'workspace' && <span>{workspaceName}</span>}</span>
    {presentation === 'workspace' && hasAttention && <span aria-hidden="true" className="account-attention-dot" />}
    {impersonator && <span className="account-impersonator"><Avatar member={impersonator} size="small" title={`Impersonated by ${impersonator.name}`} /></span>}
    {presentation === 'workspace' && <ChevronDown aria-hidden="true" size={14} />}
  </button>;
}
